# Third-party notices

AWG-Easy 3 contains or downloads software distributed under licenses separate
from the project's CC BY-NC-SA 4.0 license. Those components retain their own
copyright notices and license terms; inclusion does not relicense them.

## Bundled AWG components

| Component | Pinned revision | License | Source |
| --- | --- | --- | --- |
| AmneziaWG Go | `1b86b2ae0e493e7ea93f8c1a0f0cb6735b1551f1` | MIT | [amnezia-vpn/amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) |
| AmneziaWG Tools | `ee0f0a9aa34ff0a0da4b3433b9512781cfe02843` | GPL-2.0 | [amnezia-vpn/amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools) |

The container build compiles these exact revisions. Their license files and
source repositories are the authoritative terms for those components.

## JavaScript production dependencies

The direct production dependencies are `bcryptjs` and `qrcode`, both under the
MIT license. Their locked transitive production dependencies are:

- MIT: `ansi-regex`, `ansi-styles`, `camelcase`, `color-convert`, `color-name`,
  `decamelize`, `dijkstrajs`, `emoji-regex`, `find-up`,
  `is-fullwidth-code-point`, `locate-path`, `p-limit`, `p-locate`, `p-try`,
  `path-exists`, `pngjs`, `string-width`, `strip-ansi`, `wrap-ansi`, `y18n`,
  and `yargs`;
- ISC: `cliui`, `get-caller-file`, `require-directory`,
  `require-main-filename`, `set-blocking`, `which-module`, and `yargs-parser`.

Exact versions and integrity hashes are recorded in `src/pnpm-lock.yaml`.

## Container base images

The image is built from digest-pinned official Node.js/Alpine images. Packages
installed from Alpine retain the licenses published with their corresponding
Alpine package sources. The resulting image must be redistributed in
accordance with those package licenses as well as the licenses listed above.

