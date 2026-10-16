// 文件快转 · 局域网文件互传（Go 单文件版）
// 功能：同一局域网内多设备网页互传文件
//  - 实时广播发送 / 4位端口码点对点发送
//  - 接收方下载后自动删除、24小时兜底清理、启动清空、退出清理
//  - WebSocket 实时在线设备 / 文件到达推送
//  - 二维码扫码访问、自动打开浏览器
// 前端页面通过 go:embed 内嵌进单个 exe，零外部文件依赖。

package main

import (
	"archive/zip"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	qrcode "github.com/skip2/go-qrcode"
)

//go:embed public
var publicFS embed.FS

// ---------------- 全局状态 ----------------

var (
	mu         sync.Mutex
	wsMu       sync.Mutex
	files      = map[string]*FileMeta{}
	batches    = map[string]*Batch{}
	rooms      = map[string]*Room{}
	roomMems   = map[string]map[*wsConn]bool{}
	conns      = map[*wsConn]bool{}
	devicesBy  = map[string]*wsConn{} // deviceID -> conn
	storageDir string
	currentURL string
	baseDir    string
)

type FileMeta struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	RelPath   string `json:"relPath"`
	BatchID   string `json:"batchId"`
	Scope     string `json:"scope"`
	RoomCode  string `json:"roomCode"`
	Uploaded  int64  `json:"uploadedAt"`
	FilePath  string `json:"-"`
}

type Batch struct {
	ID          string `json:"id"`
	Scope       string `json:"scope"`
	RoomCode    string `json:"roomCode"`
	DisplayName string `json:"displayName"`
	FileCount   int    `json:"fileCount"`
	TotalSize   int64  `json:"totalSize"`
	SenderName  string `json:"senderName"`
	Uploaded    int64   `json:"uploadedAt"`
	FileIDs     []string `json:"fileIds"`
	FirstFileID string  `json:"firstFileId"`
	Dir         string  `json:"-"`
}

type Room struct {
	Code       string
	Created    int64
	LastActive int64
}

type wsConn struct {
	conn       *websocket.Conn
	writeMu    sync.Mutex
	deviceID   string
	deviceName string
	ip         string
	lastPong   time.Time
}

// ---------------- 工具函数 ----------------

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func now() int64 { return time.Now().Unix() }

func jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": msg})
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// sanitize 文件名：去掉路径分隔与非法字符
func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, "/", "_")
	s = strings.ReplaceAll(s, "\\", "_")
	s = strings.ReplaceAll(s, ":", "_")
	s = strings.ReplaceAll(s, "*", "_")
	s = strings.ReplaceAll(s, "?", "_")
	s = strings.ReplaceAll(s, "\"", "_")
	s = strings.ReplaceAll(s, "<", "_")
	s = strings.ReplaceAll(s, ">", "_")
	s = strings.ReplaceAll(s, "|", "_")
	if s == "" || s == "." || s == ".." {
		s = "未命名文件"
	}
	return s
}

// cleanRelPath 规整相对路径：拆分 / 与 \，过滤空段、. 与 ..
func cleanRelPath(s string) string {
	s = strings.ReplaceAll(s, "\\", "/")
	parts := strings.Split(s, "/")
	out := []string{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || p == "." || p == ".." {
			continue
		}
		out = append(out, sanitizeName(p))
	}
	if len(out) == 0 {
		return "未命名文件"
	}
	return strings.Join(out, "/")
}

func attachmentDisposition(name string) string {
	enc := url.PathEscape(name)
	return "attachment; filename=\"" + strings.ReplaceAll(name, "\"", "") + "\"; filename*=UTF-8''" + enc
}

func lanIPs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var all []string
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipn.IP
		if ip.IsLoopback() || ip.To4() == nil {
			continue
		}
		v4 := ip.To4()
		// 过滤 APIPA 保留地址（169.254.0.0/16，未连网的虚拟网卡常见）
		if v4[0] == 169 && v4[1] == 254 {
			continue
		}
		all = append(all, ip.String())
	}
	// 优先私网段（10/8、172.16/12、192.168/16），其余（如 VPN/虚拟网卡）排后
	var pri, others []string
	for _, s := range all {
		parts := strings.Split(s, ".")
		if len(parts) != 4 {
			continue
		}
		a, _ := strconv.Atoi(parts[0])
		b, _ := strconv.Atoi(parts[1])
		if a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) {
			pri = append(pri, s)
		} else {
			others = append(others, s)
		}
	}
	sort.Strings(pri)
	sort.Strings(others)
	return append(pri, others...)
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------------- 存储清理 ----------------

func wipeStorage() {
	entries, err := os.ReadDir(storageDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		os.RemoveAll(filepath.Join(storageDir, e.Name()))
	}
}

// 清理超过24小时的批次（兜底）
func sweepExpired() {
	cut := now() - 24*3600
	mu.Lock()
	var deadBatches []*Batch
	for _, b := range batches {
		if b.Uploaded < cut {
			deadBatches = append(deadBatches, b)
		}
	}
	for _, b := range deadBatches {
		delete(batches, b.ID)
		for _, fid := range b.FileIDs {
			if fm := files[fid]; fm != nil {
				os.Remove(fm.FilePath)
				delete(files, fid)
			}
		}
		os.RemoveAll(b.Dir)
	}
	mu.Unlock()
}

// removeFileAndBatch 下载完成后删除（单文件批次）
func removeSingle(id string) {
	mu.Lock()
	fm := files[id]
	if fm == nil {
		mu.Unlock()
		return
	}
	b := batches[fm.BatchID]
	batchID := fm.BatchID
	delete(files, id)
	if b != nil {
		delete(batches, b.ID)
		for _, fid := range b.FileIDs {
			if fid != id {
				if o := files[fid]; o != nil {
					os.Remove(o.FilePath)
					delete(files, fid)
				}
			}
		}
		os.RemoveAll(b.Dir)
	}
	mu.Unlock()
	notifyRemoved(batchID)
}

// removeBatch 下载完成后删除整个批次
func removeBatch(id string) {
	mu.Lock()
	b := batches[id]
	if b == nil {
		mu.Unlock()
		return
	}
	for _, fid := range b.FileIDs {
		if fm := files[fid]; fm != nil {
			os.Remove(fm.FilePath)
			delete(files, fid)
		}
	}
	delete(batches, id)
	dir := b.Dir
	mu.Unlock()
	os.RemoveAll(dir)
	notifyRemoved(id)
}

func notifyRemoved(batchID string) {
	ev := map[string]interface{}{"type": "file-removed", "batchId": batchID}
	wsMu.Lock()
	defer wsMu.Unlock()
	for c := range conns {
		c.send(ev)
	}
}

// ---------------- WebSocket ----------------

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (c *wsConn) send(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.conn.WriteMessage(websocket.TextMessage, data)
}

func devicesSnapshot() []map[string]interface{} {
	wsMu.Lock()
	defer wsMu.Unlock()
	list := []map[string]interface{}{}
	for id, c := range devicesBy {
		list = append(list, map[string]interface{}{
			"deviceId": id,
			"name":     c.deviceName,
			"ip":       c.ip,
		})
	}
	return list
}

func broadcastDevices() {
	ev := map[string]interface{}{"type": "devices", "devices": devicesSnapshot()}
	wsMu.Lock()
	defer wsMu.Unlock()
	for c := range conns {
		c.send(ev)
	}
}

func roomFilesView(code string) []*Batch {
	mu.Lock()
	defer mu.Unlock()
	list := []*Batch{}
	for _, b := range batches {
		if b.Scope == "room" && b.RoomCode == code {
			list = append(list, b)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Uploaded < list[j].Uploaded })
	return list
}

func broadcastFilesView() []*Batch {
	mu.Lock()
	defer mu.Unlock()
	list := []*Batch{}
	for _, b := range batches {
		if b.Scope == "broadcast" {
			list = append(list, b)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Uploaded < list[j].Uploaded })
	return list
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &wsConn{conn: c, ip: remoteIP(r), lastPong: time.Now()}
	wsMu.Lock()
	conns[conn] = true
	wsMu.Unlock()

	defer func() {
		wsMu.Lock()
		delete(conns, conn)
		if conn.deviceID != "" && devicesBy[conn.deviceID] == conn {
			delete(devicesBy, conn.deviceID)
		}
		for _, m := range roomMems {
			delete(m, conn)
		}
		wsMu.Unlock()
		c.Close()
		broadcastDevices()
	}()

	// 心跳：30s ping，60s 无 pong 断开
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				conn.writeMu.Lock()
				conn.conn.WriteMessage(websocket.PingMessage, nil)
				conn.writeMu.Unlock()
				if time.Since(conn.lastPong) > 60*time.Second {
					c.Close()
					return
				}
			}
		}
	}()
	defer close(done)

	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return
		}
		var msg map[string]interface{}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg["type"] {
		case "hello":
			deviceID, _ := msg["deviceId"].(string)
			deviceName, _ := msg["deviceName"].(string)
			if deviceID == "" {
				deviceID = newID()
			}
			wsMu.Lock()
			if old := devicesBy[deviceID]; old != nil && old != conn {
				old.conn.Close()
			}
			devicesBy[deviceID] = conn
			wsMu.Unlock()
			conn.deviceID = deviceID
			conn.deviceName = deviceName
			conn.send(map[string]interface{}{
				"type":     "welcome",
				"deviceId": deviceID,
				"devices":  devicesSnapshot(),
			})
			broadcastDevices()
		case "join-room":
			code, _ := msg["code"].(string)
			code = strings.TrimSpace(code)
			mu.Lock()
			room := rooms[code]
			if room != nil {
				room.LastActive = now()
				if roomMems[code] == nil {
					roomMems[code] = map[*wsConn]bool{}
				}
				roomMems[code][conn] = true
			}
			mu.Unlock()
			if room == nil {
				conn.send(map[string]interface{}{"type": "room-joined", "ok": false, "error": "端口码不存在或已失效"})
			} else {
				conn.send(map[string]interface{}{"type": "room-joined", "ok": true, "code": code, "files": roomFilesView(code)})
			}
		case "pong":
			conn.lastPong = time.Now()
		}
	}
}

// ---------------- 上传 ----------------

func handleUpload(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	if mode != "room" {
		mode = "broadcast"
	}
	roomCode := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("code")))
	if mode == "room" {
		mu.Lock()
		room := rooms[roomCode]
		if room == nil {
			mu.Unlock()
			jsonErr(w, 404, "端口码不存在或已失效")
			return
		}
		room.LastActive = now()
		mu.Unlock()
	}

	mr, err := r.MultipartReader()
	if err != nil {
		jsonErr(w, 400, "请求格式错误")
		return
	}

	batchID := newID()
	batchDir := filepath.Join(storageDir, batchID)
	os.MkdirAll(batchDir, 0755)

	type fi struct {
		tmp  string
		orig string
		size int64
	}
	var fInfos []fi
	var relPaths []string
	var topName, senderName string
	seq := 0

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			os.RemoveAll(batchDir)
			jsonErr(w, 400, "读取上传数据失败")
			return
		}
		if part.FormName() == "files" {
			tmp := filepath.Join(batchDir, "__tmp_"+strconv.Itoa(seq))
			f, err := os.Create(tmp)
			if err != nil {
				part.Close()
				os.RemoveAll(batchDir)
				jsonErr(w, 500, "服务器写入失败")
				return
			}
			size, copyErr := io.Copy(f, part)
			f.Close()
			part.Close()
			if copyErr != nil {
				os.RemoveAll(batchDir)
				jsonErr(w, 400, "上传中断")
				return
			}
			fInfos = append(fInfos, fi{tmp: tmp, orig: part.FileName(), size: size})
			seq++
		} else {
			val, _ := io.ReadAll(io.LimitReader(part, 1<<20))
			part.Close()
			switch part.FormName() {
			case "relativePath":
				relPaths = append(relPaths, string(val))
			case "topName":
				topName = string(val)
			case "senderName":
				senderName = string(val)
			}
		}
	}

	if len(fInfos) == 0 {
		os.RemoveAll(batchDir)
		jsonErr(w, 400, "没有收到文件")
		return
	}

	// 落盘到最终路径（重建目录结构），并建元数据
	var ids []string
	var total int64
	for i, info := range fInfos {
		rel := ""
		if i < len(relPaths) {
			rel = relPaths[i]
		}
		if rel == "" {
			rel = info.orig
		}
		rel = cleanRelPath(rel)

		fileID := newID()
		relDir := path.Dir(rel)
		base := path.Base(rel)
		target := batchDir
		if relDir != "." {
			target = filepath.Join(batchDir, filepath.FromSlash(relDir))
		}
		os.MkdirAll(target, 0755)

		fp := filepath.Join(target, base)
		stem := strings.TrimSuffix(fp, filepath.Ext(fp))
		ext := filepath.Ext(fp)
		n := 1
		for fileExists(fp) {
			fp = fmt.Sprintf("%s (%d)%s", stem, n, ext)
			n++
		}
		if err := os.Rename(info.tmp, fp); err != nil {
			os.Remove(info.tmp)
		}

		fm := &FileMeta{
			ID:       fileID,
			Name:     base,
			Size:     info.size,
			RelPath:  rel,
			BatchID:  batchID,
			Scope:    mode,
			RoomCode: roomCode,
			Uploaded: now(),
			FilePath: fp,
		}
		mu.Lock()
		files[fileID] = fm
		mu.Unlock()
		ids = append(ids, fileID)
		total += info.size
	}

	// 显示名
	display := topName
	if display == "" {
		if len(fInfos) == 1 {
			display = cleanRelPath(relPaths[0])
		} else {
			display = fmt.Sprintf("多文件传输（%d 个文件）", len(fInfos))
		}
	}

	batch := &Batch{
		ID:          batchID,
		Scope:       mode,
		RoomCode:    roomCode,
		DisplayName: display,
		FileCount:   len(fInfos),
		TotalSize:   total,
		SenderName:  senderName,
		Uploaded:    now(),
		FileIDs:     ids,
		FirstFileID: ids[0],
		Dir:         batchDir,
	}
	mu.Lock()
	batches[batchID] = batch
	mu.Unlock()

	// WS 推送
	ev := map[string]interface{}{
		"type":  "file-arrived",
		"batch": batch,
	}
	if mode == "broadcast" {
		wsMu.Lock()
		for c := range conns {
			c.send(ev)
		}
		wsMu.Unlock()
	} else {
		mu.Lock()
		members := roomMems[roomCode]
		mu.Unlock()
		wsMu.Lock()
		for c := range members {
			c.send(ev)
		}
		wsMu.Unlock()
	}

	jsonOK(w, map[string]interface{}{
		"ok":          true,
		"batchId":     batchID,
		"displayName": display,
		"fileCount":   len(fInfos),
	})
}

// ---------------- 列表 / 房间 ----------------

func handleBroadcastFiles(w http.ResponseWriter, r *http.Request) {
	jsonOK(w, map[string]interface{}{"ok": true, "files": broadcastFilesView()})
}

func handleRoomCreate(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	defer mu.Unlock()
	// 清理超过 2 小时未活动的房间
	cut := now() - 2*3600
	for code, rm := range rooms {
		if rm.LastActive < cut {
			delete(rooms, code)
			delete(roomMems, code)
		}
	}
	var code string
	for {
		code = fmt.Sprintf("%04d", time.Now().UnixNano()%10000)
		if _, ok := rooms[code]; !ok {
			break
		}
	}
	rooms[code] = &Room{Code: code, Created: now(), LastActive: now()}
	jsonOK(w, map[string]interface{}{"ok": true, "code": code})
}

func handleRoomJoin(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("code")))
	// 兼容前端 JSON body 传 code（{code:"1234"}）
	if code == "" && r.Body != nil {
		var b struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&b); err == nil {
			code = strings.ToUpper(strings.TrimSpace(b.Code))
		}
	}
	mu.Lock()
	room := rooms[code]
	if room != nil {
		room.LastActive = now()
	}
	mu.Unlock()
	if room == nil {
		jsonErr(w, 404, "端口码不存在或已失效")
		return
	}
	jsonOK(w, map[string]interface{}{"ok": true, "code": code, "files": roomFilesView(code)})
}

func handleRoomFiles(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("code")))
	mu.Lock()
	room := rooms[code]
	mu.Unlock()
	if room == nil {
		jsonErr(w, 404, "端口码不存在或已失效")
		return
	}
	jsonOK(w, map[string]interface{}{"ok": true, "files": roomFilesView(code)})
}

// ---------------- 下载 ----------------

func handleDownload(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/download/")
	mu.Lock()
	fm := files[id]
	mu.Unlock()
	if fm == nil {
		jsonErr(w, 404, "文件不存在或已被下载")
		return
	}
	if !fileExists(fm.FilePath) {
		jsonErr(w, 404, "文件不存在或已被下载")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", attachmentDisposition(fm.Name))
	w.Header().Set("Content-Length", strconv.FormatInt(fm.Size, 10))
	f, err := os.Open(fm.FilePath)
	if err != nil {
		jsonErr(w, 500, "打开文件失败")
		return
	}
	defer f.Close()
	_, err = io.Copy(w, f)
	if err == nil {
		removeSingle(id)
	}
}

func handleDownloadBatch(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/download-batch/")
	mu.Lock()
	b := batches[id]
	mu.Unlock()
	if b == nil {
		jsonErr(w, 404, "批次不存在或已被下载")
		return
	}

	zipName := sanitizeName(b.DisplayName) + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", attachmentDisposition(zipName))

	zw := zip.NewWriter(w)
	for _, fid := range b.FileIDs {
		mu.Lock()
		fm := files[fid]
		mu.Unlock()
		if fm == nil || !fileExists(fm.FilePath) {
			continue
		}
		f, err := os.Open(fm.FilePath)
		if err != nil {
			continue
		}
		hdr := &zip.FileHeader{Name: filepath.ToSlash(fm.RelPath), Method: zip.Store}
		hdr.SetModTime(time.Unix(fm.Uploaded, 0))
		e, err := zw.CreateHeader(hdr)
		if err != nil {
			f.Close()
			break
		}
		_, err = io.Copy(e, f)
		f.Close()
		if err != nil {
			break
		}
	}
	err := zw.Close()
	if err == nil {
		removeBatch(id)
	}
}

// ---------------- 二维码 / 首页 ----------------

func handleQR(w http.ResponseWriter, r *http.Request) {
	png, err := qrcode.Encode(currentURL, qrcode.Medium, 320)
	if err != nil {
		http.Error(w, "qr error", 500)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(png)
}

// ---------------- 主流程 ----------------

func main() {
	// 工作目录：exe 所在目录
	exePath, err := os.Executable()
	if err != nil {
		exePath = "."
	}
	baseDir = filepath.Dir(exePath)
	storageDir = filepath.Join(baseDir, "storage")
	os.MkdirAll(storageDir, 0755)

	// 启动清空（保证强杀也不残留）
	wipeStorage()

	// 退出清理
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		<-ch
		fmt.Println("正在退出，清理临时文件…")
		wipeStorage()
		os.Exit(0)
	}()

	// 24h 兜底清理
	go func() {
		t := time.NewTicker(time.Hour)
		for range t.C {
			sweepExpired()
		}
	}()

	// 找端口
	var ln net.Listener
	port := 0
	for p := 3000; p <= 3019; p++ {
		l, err := net.Listen("tcp", ":"+strconv.Itoa(p))
		if err == nil {
			ln = l
			port = p
			break
		}
	}
	if ln == nil {
		fmt.Println("端口 3000-3019 均被占用，无法启动")
		return
	}

	ips := lanIPs()
	currentURL = fmt.Sprintf("http://localhost:%d", port)
	if len(ips) > 0 {
		currentURL = fmt.Sprintf("http://%s:%d", ips[0], port)
	}

	// 控制台提示
	fmt.Println("")
	fmt.Println("  ╔══════════════════════════════════════════════╗")
	fmt.Println("  ║           文件快转 · 局域网文件互传          ║")
	fmt.Println("  ╚══════════════════════════════════════════════╝")
	fmt.Println("")
	fmt.Println("  服务已启动，端口: " + strconv.Itoa(port))
	fmt.Println("")
	fmt.Println("  本机访问:  http://localhost:" + strconv.Itoa(port))
	for _, ip := range ips {
		fmt.Println("  局域网访问: http://" + ip + ":" + strconv.Itoa(port))
	}
	if len(ips) == 0 {
		fmt.Println("  (未检测到局域网 IP，请确认电脑已连接 WiFi/网线)")
	}
	fmt.Println("")
	fmt.Println("  手机扫码访问（手机连接同一 WiFi 后扫码即可）：")
	if q, err := qrcode.New(currentURL, qrcode.Medium); err == nil {
		fmt.Println(q.ToString(true))
	}
	fmt.Println("  " + currentURL)
	fmt.Println("")
	fmt.Println("  使用提示:")
	fmt.Println("  · 手机和电脑连接同一 WiFi 后，扫码或打开上面的“局域网访问”地址")
	fmt.Println("  · 首次运行时 Windows 防火墙可能弹窗，请选择“允许访问”")
	fmt.Println("  · 接收方下载文件后，文件会自动删除")
	fmt.Println("  · 关闭本窗口即停止服务")
	fmt.Println("")

	// 自动打开浏览器
	go func() {
		time.Sleep(800 * time.Millisecond)
		exec.Command("cmd", "/c", "start", "", "http://localhost:"+strconv.Itoa(port)).Start()
	}()

	// 路由
	sub, err := fs.Sub(publicFS, "public")
	if err != nil {
		fmt.Println("内嵌前端资源加载失败:", err)
		return
	}
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/api/upload", handleUpload)
	mux.HandleFunc("/api/broadcast/files", handleBroadcastFiles)
	mux.HandleFunc("/api/room/create", handleRoomCreate)
	mux.HandleFunc("/api/room/join", handleRoomJoin)
	mux.HandleFunc("/api/room/files", handleRoomFiles)
	mux.HandleFunc("/api/download/", handleDownload)
	mux.HandleFunc("/api/download-batch/", handleDownloadBatch)
	mux.HandleFunc("/api/qr", handleQR)
	mux.HandleFunc("/ws", handleWS)

	srv := &http.Server{Handler: mux}
	if err := srv.Serve(ln); err != nil {
		fmt.Println("服务退出:", err)
	}
}
