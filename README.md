# Veyrin Speaker Cards

A lightweight SillyTavern UI extension that turns one AI response into visually separated speaker cards while keeping the underlying generation as a single assistant message.

## What v0.1.3 does

- Keeps one story generation / one main-model API call.
- Injects a short, late prompt instruction telling the model to emit `[[SPK:Name]] ... [[/SPK]]` speaker markers.
- Renders those markers as separate DM/NPC cards after the message is received.
- Supports repeated speaker changes in one response: `Veyrin DM → Elena → Veyrin DM → Valeria → Seraphine Veyl → Veyrin DM`.
- Supports any NPC name automatically.
- Lets you add portraits *after installation* from the SillyTavern Extensions panel.
- Supports multiple portraits per character, a default portrait, and optional deterministic variation.
- Stores portraits locally in the browser with IndexedDB/localforage.
- Exports/imports a portrait pack for backup or transfer.
- Leaves existing unmarked messages unchanged.
- Skips prompt injection for quiet/impersonation generations so background helper calls are not polluted.
- Does not make any additional LLM/API calls.

## Installation from a Git repository

SillyTavern supports third-party UI extensions directly from a Git repository URL.

1. Open **Extensions**.
2. Choose **Install Extension**.
3. Paste the repository URL.
4. Install and reload if SillyTavern asks you to.

## Adding portraits after installation

Open **Extensions → Veyrin Speaker Cards**.

1. Enter the exact character name (for example `Elena`).
2. Click **Add Portrait**.
3. Choose the image file when the file picker opens.

You can add several images for the same character. Click `★`/`☆` to choose the default.

Portrait images are resized to a maximum of 768 px on the long edge for efficient display/storage. The original source file is not modified.

## Veyrin-only behavior

By default the extension applies only when the active SillyTavern character is named `Veyrin DM` or `Veyrin`. Change the comma-separated list in settings if your DM card uses another name.

## ScenePulse

The extension makes no ScenePulse call. A ScenePulse machine-readable trailer is allowed to remain outside speaker blocks and is stripped only from the *visual speaker-card rendering*; the raw chat message is not rewritten.

## Cache behavior

The speaker-format instruction is injected as a stable system prompt at in-chat depth 0. This keeps it near the changing tail rather than modifying the large static beginning of the prompt.

## Storage note

Portraits are stored in the browser that uploaded them. If you use SillyTavern from multiple browsers/devices, use **Export Portrait Pack** and **Import Portrait Pack** to copy the portrait library to the other browser.

## License

MIT


## v0.1.3 fix

- **Add Portrait** now opens the image file picker directly. This fixes the v0.1.0 issue where SillyTavern could hide the standalone file input, causing “Choose an image file” when the button was clicked.
