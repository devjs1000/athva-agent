# Athva

An agentic coding assistant desktop app built with Tauri 2, Vite, and TypeScript.

## Installation (macOS)

Download the latest `.dmg` from the [Releases](../../releases) page.

> **"Athva is damaged and can't be opened"?**
>
> The app is not code-signed with an Apple Developer certificate, so macOS Gatekeeper blocks it with a misleading "damaged" message. The app is fine — remove the quarantine flag and it will open normally:
>
> ```bash
> xattr -cr /Applications/Athva.app
> ```
>
> Run this once after copying Athva to your Applications folder.

## Development

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run tauri build
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
