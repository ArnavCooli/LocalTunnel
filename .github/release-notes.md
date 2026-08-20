Rebuild of the LocalTunnel desktop app for every supported platform, including the security hardening and fixes landed after 1.1.

## Downloads

| Platform | File |
| --- | --- |
| macOS (Apple Silicon) | `LocalTunnel-1.0.0-arm64.dmg` |
| macOS (Intel + Apple Silicon) | `LocalTunnel-1.0.0-universal.dmg` |
| Windows x64 | `LocalTunnel-1.0.0-x64.exe` |
| Windows arm64 | `LocalTunnel-1.0.0-arm64.exe` |
| Linux x86_64 (AppImage) | `LocalTunnel-1.0.0-x86_64.AppImage` |
| Linux arm64 (AppImage) | `LocalTunnel-1.0.0-arm64.AppImage` |
| Debian/Ubuntu amd64 | `localtunnel-desktop_1.0.0_amd64.deb` |
| Debian/Ubuntu arm64 | `localtunnel-desktop_1.0.0_arm64.deb` |
| VPS gateway bundle | `localtunnel-gateway.tar.gz` |

The gateway tarball is the same bundle the desktop app uploads to your VPS over SSH; it is published here for manual or scripted installs.

## Notes

- Builds are unsigned on macOS and Windows, so Gatekeeper and SmartScreen warn on first launch.
- Built against Electron 33.4.11 on Node 22, with the full test suite passing on each platform.
