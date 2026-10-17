# Diep.io FOV Script

A Tampermonkey userscript for [Diep.io](https://diep.io/) with adjustable camera zoom, a normal-FOV reference box, and experimental drone visualizations.

## Features

- **Camera zoom:** adjust visible width from **0.10× to 3.00×** the normal camera.
- **Normal-FOV outline:** a red box marks the normal camera view.
- **Drone cursor estimates:** cyan lines through visible drone headings estimate where a cursor may be.
- **Drone shadows:** purple markers predict selected drones' movement after they leave the normal view, using momentum, drag, and your controls.
- **Player locator:** estimates possible positions for one opponent from inferred cursor observations and movement constraints.
- **Saved preferences:** zoom level and overlay settings are stored in the site's local storage. Camera zoom starts disabled after every reload.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open [script.js](./script.js), then select **Raw** and copy the complete file.
3. Open the Tampermonkey dashboard and create a new script.
4. Replace the template with the copied code, save it, and make sure the script is enabled.
5. Open or reload [Diep.io](https://diep.io/). The **FOV editor** panel appears in the top-right corner.

The userscript is currently named **1v1** in its metadata, so that is the name shown in Tampermonkey. It matches both `https://diep.io/*` and `https://www.diep.io/*` and runs at `document-start`.

No build step or package installation is required.

## Camera controls

Wait for the panel to show **Ready**, then press **J** or click **Enable** to activate zoom.

| Control | Action |
| --- | --- |
| **J** | Toggle camera zoom; disabling restores normal zoom |
| **Mouse wheel down** | Increase visible width / zoom out |
| **Mouse wheel up** | Decrease visible width / zoom in |
| **Shift + mouse wheel** | Also adjust zoom |
| **+ / −** buttons | Increase / decrease visible width |
| **Reset 1×** | Set the multiplier to normal camera width |
| **Alt + H** | Hide or show the panel |
| **Alt + C** | Toggle drone cursor rays |

A multiplier above **1×** shows a wider view; below **1×** shows a closer view. Wheel adjustments apply only while camera zoom is enabled. Keyboard shortcuts are ignored while typing in inputs or using modal dialogs.

Hiding the panel leaves active features running. To stop the entire userscript, disable it in Tampermonkey and reload the page.

## Drone visualizations

### Cursor rays

Expand **Drone cursor settings** to show all detected drone colors or select one color. Use **Front corner** to choose which triangle corner represents the drone's heading; check it against your own drones while aiming steadily.

Cyan lines extend through each drone's center and front corner in both directions. Their intersections estimate a cursor for each detected group. A dashed marker means the crossing distance is still uncertain; estimates based on two drones are tentative.

### Drone shadows

1. Expand **Drone shadow settings**.
2. Click **Pick my drones**, then click one of your visible drones. You can also select a color or enter a hex code.
3. Zoom out above **1×** to see predicted shadows beyond the normal-FOV box.
4. Adjust **Keep shadows for** as needed; the default is **15 seconds**.

The predictor reads the game's saved custom bindings. With default bindings, left mouse / **Space** attracts, right mouse / **Shift** repels, and **E** toggles auto-fire. The prediction target stays inside the red normal-FOV box; actual game aiming is unchanged.

Arena movement limits are estimated automatically and shown with amber dashes. Shared team colors may cause teammates' drones to be included.

### Player locator

Expand **Player locator settings** and use **Pick opponent drones** to select one opponent's drone color, or turn on **Player locator** to use automatic color selection. The locator starts off by default. Automatic selection skips your selected shadow color and pauses observations when multiple matching cursor estimates are ambiguous.

- **Green outlines:** possible current positions.
- **Blue dotted outlines:** predicted possible positions.
- **Dashed outer boxes:** bounds around those regions, rather than an exact location.

The locator assumes the inferred cursor remains inside the opponent's normal view. Its default opponent view follows a **1920×1080 level-45 Overlord** view; adjust the view dimensions and movement settings when those assumptions differ. Use **Reset history** to clear accumulated observations.

## Compatibility and limitations

Camera patching requires a supported Diep.io WebAssembly build. The script verifies the binary's size and SHA-256 fingerprint, checks camera instruction guards, and validates the patched module before using it.

If the panel reports **Unsupported**, the game client needs an updated camera profile. The loader falls back to the original game bytes when patching is unavailable. A game update can therefore disable camera zoom until the script is updated.

Drone overlays depend on visible rendered drones and usable camera data. Cursor intersections, shadows, arena limits, and player regions are estimates; they do not provide authoritative hidden positions. Weak or ambiguous cursor geometry can prevent locator updates.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| No panel | Confirm Tampermonkey and **1v1** are enabled, check that you are on Diep.io, then reload |
| Panel stays on **Waiting** | Reload with the userscript already enabled so it can intercept the game's WebAssembly loading |
| **Unsupported** client | Check for a script update containing a matching camera profile |
| Wheel does nothing | Enable camera zoom first and move the pointer outside the panel or editable fields |
| Panel disappeared | Press **Alt + H** outside an input field |
| No cursor rays | Enable **Cursor rays**, keep drones visible, and check the color filter and front-corner setting |
| No drone shadows | Select your drone color and zoom out above **1×** |
| Locator is empty or inconsistent | Select one opponent, check the view/movement assumptions, and reset history |

To update manually, replace the installed userscript with the latest contents of [script.js](./script.js), save, and reload Diep.io.

## Repository

- [script.js](./script.js) — complete userscript, including camera patching, controls, and overlays.
- [Issues](https://github.com/kzy09c/diep-fov-script/issues) — report problems with the panel status, reproduction steps, browser, and installed script version.

## License

This repository currently has no standalone license file. Some embedded sections carry MIT SPDX notices; see [script.js](./script.js) for those notices.
