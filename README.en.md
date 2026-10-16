# File Quick Transfer (文件快转) · LAN File Quick Transfer

> Transfer files quickly between PC / phone / tablet over a web page on the same LAN.
> Zero install, zero residue, single ~6 MB executable, ready to use on launch.

## Introduction

File Quick Transfer is a lightweight LAN file-transfer tool written in Go. No client installation, no login, no public server required — on the same WiFi / LAN, any device can open a browser and transfer files instantly.

The front end is embedded into a single executable via `go:embed`, with no external resource dependencies.

## Features

- **Live broadcast**: sender uploads files, receivers discover them automatically and get real-time updates (WebSocket push)
- **Peer-to-peer room code**: sender generates a 4-digit code; receiver enters it to receive privately — code in, files in
- **Multi-file / folder**: batch upload and drag-and-drop folders; downloads preserve directory structure as a zip
- **Multi-device**: works on PC, phone and tablet with a responsive UI for small screens
- **QR code access**: a QR code is printed in the console on startup; phones scan it to open the page directly — no typing addresses
- **Zero residue**: files are deleted after download, with a 24-hour fallback sweep, cleanup on exit and on startup — even a forced kill leaves nothing behind
- **Single file**: the whole front end is embedded; the exe has no external dependencies and can be copied and shared as-is
- **Large-file friendly**: streaming upload / download — 50 MB-class files finish in seconds with stable memory usage

## Quick Start (Windows)

1. Download the release `文件快转.exe`
2. Double-click to run (Windows Firewall may prompt on first run — choose "Allow access")
3. The app opens your browser automatically; with your phone on the same WiFi, scan the QR code in the console or on the home page with your camera / browser

> Non-Windows users can build their own binary following "Developer Build" below.

## Usage

- **Home page**: shows the service address, QR code and the number of online devices
- **Send files**: choose "Live broadcast" (all receivers get the files automatically) or "Peer-to-peer" (generate a 4-digit code; only receivers who enter the code can get the files)
- **Receive files**: choose "Auto receive" (live broadcast) or enter a code for "Peer-to-peer receive"
- **Delete after download**: once a receiver finishes downloading, the server immediately removes the file and its batch

## Developer Build

Requires Go 1.22+:

```bash
go mod tidy
go build -trimpath -ldflags "-s -w" -o 文件快转.exe .
```

To embed an app icon into the Windows exe (`rsrc` generates the resource object, which Go links automatically):

```bash
go install github.com/akavel/rsrc@latest
rsrc -ico app.ico -arch amd64 -o rsrc_windows_amd64.syso
go build -trimpath -ldflags "-s -w" -o 文件快转.exe .
```

> Note: `app.ico` can be any multi-size Windows icon file (16/32/48/64/128/256 recommended); the app icon was AI-assisted and you can preview it in the exe attached to the release.

## Directory Layout

```
├── main.go              # Go server: HTTP + WebSocket + storage cleanup + QR code
├── public/              # Front end (embedded via go:embed)
│   ├── index.html       # Home / Send / Receive (inline SVG arrow mark, no external images)
│   ├── style.css
│   └── app.js
├── test-go.js           # 21 end-to-end automated tests (requires a running server)
├── docs/使用说明.md      # Chinese detailed usage guide
├── go.mod / go.sum
└── LICENSE
```

## Storage & Privacy

- Uploaded files are kept only in the `storage/` temp folder next to the program and are deleted immediately after a successful download
- Undownloaded files are swept after 24 hours; the folder is cleared on exit and again on next startup — nothing is left behind
- All transfers happen inside your LAN; no public server is involved

## Testing

Run while the server is running (requires Node.js):

```bash
node test-go.js
```

Covers: home page, QR code, broadcast upload / download / auto-delete, folder zip, room-code create / join / room download, invalid-code 404, WebSocket real-time push.

## License

[MIT](./LICENSE) © 2026 Soeiat66

## Fully Open Source · AI-Created Notice

This project is **fully open source** (MIT License) and **entirely created by AI**: from requirements analysis, architecture design, core code (Go server and front end), UI design, app icon, test scripts and documentation, to the creation of the GitHub repository and the publishing of the code — everything was done independently by AI. The project owner only provided the requirements and authorization.

If you find any issues or areas for improvement, you are very welcome to **discuss, remix and modify**. You can fork this project, file issues / PRs, or build your own version on top of it. When using or redistributing this project, please keep this notice.
