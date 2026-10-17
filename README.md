# Linko MyMarketer

An installable, private PWA for preparing and explicitly publishing MyMarket listings. Choose your main photo, enter the price and description, then review the category and live form before publishing. React editor, Express server, SQLite submission journal, semantic Playwright automation and the official authenticated Codex CLI.

## Run locally

Requires Node 22.13+, pnpm 10, Chromium dependencies, and Xvfb on a Linux server for the private headed browser. The operator needs normal ChatGPT sign-in in Codex under the application's OS account. No API key is required or accepted by the panel.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm browser:install
cp .env.example .env
codex login status
# Only if needed, use Codex's supported interactive sign-in:
codex login
# Or use codex login --device-auth where enabled by your account.
corepack pnpm build
corepack pnpm start
```

Open `http://127.0.0.1:4310`. The default is a trusted local workspace. `pnpm dev` runs the editor with Vite instead of the production shell. Keep the server running for uploads, category discovery and listing work. Do not bind it to a public interface.

Codex uses its own saved ChatGPT sign-in through supported [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode) and [authentication](https://learn.chatgpt.com/docs/auth). Account/model availability and usage limits still apply. This application does not read, export or duplicate Codex authentication tokens. It supplies item text and redacted live page observations through stdin, requests schema-constrained decisions, disables tools and extra agents, and validates the result. Photos are not sent to Codex. Native sign-in and one real structured Codex decision were verified on this host; full authenticated marketplace integration remains unverified.

## Use from your phone over Tailscale

Observed server IP: **100.97.154.71**. Observed hostname: **codex-server.tail5ebb9d.ts.net**. The proposed application address is **https://codex-server.tail5ebb9d.ts.net:8443/**, but it is **not active**. The existing service on port 8787 is the manager, not this app. No service, route or tailnet permissions were changed.

The prepared release is `mymarketer-codex-tailnet-20261014-v2`. An operator must activate its dedicated service and HTTPS Serve route following [the execution report](docs/EXECUTION_REPORT.md#manager-activation-handoff). The app stays on loopback port 4310. Tailscale Serve supplies trusted user identity; an app-side hashed login allowlist and separate panel password protect the workspace. Funnel/public hosting is unsupported. Tailnet ACLs must authorize the intended owner/device; this implementation does not change them.

After the operator confirms activation:

1. Connect your phone to the authorized tailnet and open the HTTPS address supplied by the operator. Sign in with your **Linko panel password**.
2. Open the **Assistant** window (bottom-right). Enter your MyMarket phone/email and password **once** in its masked form; the server stores them privately (see below). Press **Sign in to MyMarket** or type “sign in”. The assistant signs in inside the persistent automation browser itself. If MyMarket asks for an SMS/email code, the window opens and asks; type the code back into it. No browser driving by you.
3. The signed-in session lives in the persistent browser profile and is reused: later listing runs check the session first and only sign in again (asking for a new code if required) when it has expired. Only if the assistant truly cannot proceed (for example a visual puzzle) does it show **Open private browser (fallback)**; that view is the older click-and-type remote browser under **Connection & setup**, and **Finish login & return** releases it.
4. Use Chrome's **Install app** or Safari's **Share → Add to Home Screen** on the verified HTTPS origin.

The assistant window never shows or returns your password. It is posted once to the server, written to `mymarket-account.json` in the private data directory (mode 0600, git-ignored) and typed into MyMarket by server-side Playwright code. It is never sent to Codex, the draft journal, logs, API responses or the client bundle; one-time codes are held in memory only for the moment they are entered and appear in the chat as `••••••`. Credentials are not encrypted at rest: rely on the OS account and disk encryption. **Remove saved details** in the window deletes the file.

The private browser uses a dedicated display and protected same-origin frame/input APIs. It opens no VNC, debugging or public browser port and does not attach to the shared server desktop. Only one manual login lease or automation run may use the marketplace browser at a time. The lease is bound to your panel session and expires after inactivity.

## Listing workflow

1. Upload one to eight JPEG, PNG or WebP images, up to 12 MB and 40 megapixels each. Images are decoded, rotated and normalized to EXIF-free JPEGs. The first image initializes the cover. **You choose the main photo**; no scoring or photo analysis runs. The selected image is uploaded first.
2. Enter the price and description, plus optional model, condition and city. **Find my category** uses Codex to guide semantic browser actions, searches comparable items and inspects one to three relevant listing breadcrumbs. It does not copy their factual specifications into your item or follow a hardcoded category path.
3. Review/edit the inferred title, category and supplied facts. **Check live listing form** reconciles the current category controls, discovers required fields and asks for genuinely missing facts. Unsupported widgets, uncertain categories, fees or questionable field values stop with an actionable message.
4. Review the actual form values. Publishing is disabled by default. The operator may deliberately set `ALLOW_PUBLISH=true` for real owner use; prepare again after that change. **List on MyMarket → Publish this listing** performs one guarded final submit only after your explicit confirmation.

Automation uses current DOM labels, roles, values, options and transient element handles. Codex cannot choose arbitrary selectors, coordinate clicks, credentials, payments or the final publish action. Human clicks in the private login browser are separate from semantic automation. Bounded retries re-observe the page; final publication is never automatically retried. A fresh revision, browser session, field/photo hash and final semantic audit must pass.

A durable SQLite claim prevents repeat publication of identical content/photos across draft IDs. A success receipt requires an observed confirmation and a public listing page with matching title and price. An uncertain outcome becomes **unknown**, including a process interruption; inspect the account manually before any further action. There is no automated unlock or repost endpoint.

## Privacy, offline use and limitations

Secrets, cookies and drafts remain in the ignored server data directory (default `.private/`, mode 0700; file creation mode 0600). MyMarket credentials live in `.private/mymarket-account.json`, panel password/allowlist hashes in `.private/access.json`, and browser cookies/sessions in `.private/browser/`. If `LINKO_DATA_DIR` is set, these paths are relative to that directory; keep it private and outside tracked assets.

For local environment credentials, copy the empty placeholders from `.env.example` into the ignored `.env` in the workspace root and restrict it with `chmod 600 .env`. The server loads this file through `dotenv`; exported environment variables take precedence. `MYMARKET_PHONE`/`MYMARKET_PASSWORD` are an optional server-only seed when there is no valid saved vault; the assistant window is the normal way to supply them. Keep existing private files locally when updating the checkout. Never put credentials in examples, evidence, screenshots or source code. Codex keeps its own sign-in outside this repository; the application does not copy it.

`pnpm test` includes a permanent index check that rejects tracked environment files, private keys, credential JSON and cookie/token/session data, even if force-added or missing from the working tree. Only `.env.example` and `runtime.env.example` are allowed environment templates, with empty credential fields. `pnpm security:check` also scans reachable git history without printing credential values. If a real credential is found, retain its local copy, remove it from the index with `git rm --cached -- <file>`, and rotate it with the service provider. Removing it at HEAD leaves historical exposure intact; do not rewrite history or force-push as part of this cleanup.

Runtime files are not encrypted at rest. Use a trusted OS account and encrypted disk. This is one owner's workspace and one marketplace session; authorized panel users share it. Loopback is a trusted OS boundary: unrelated local processes must also be trusted. Remote access requires the exact configured HTTPS origin, trusted loopback Tailscale proxy, allowlisted identity, secure panel session, and CSRF checks. Tagged devices without user identity fail closed.

The PWA caches the public shell and saves draft text/previews in IndexedDB. Private API responses, browser frames and credentials are not cached by the service worker. Offline text edits require explicit save after reconnecting; uploads and publishing are never queued offline. Panel sign-out clears local draft storage. Anyone using the same unlocked browser/device can access its offline drafts; keep the device private.

Cloudflare: the earlier 403 came from automation fingerprints (the default `HeadlessChrome` user agent, like curl's default agent). A headed, persistent real-Chromium profile on the private Xvfb display with the automation flags removed is admitted (HTTP 200); headless is only admitted with a normal user agent. The browser layer also waits out interstitials and dismisses MyMarket's cookie/promo overlays. See the [execution report](docs/EXECUTION_REPORT.md#agent-driven-sign-in-and-cloudflare-findings) for exactly what was verified live. MyMarket signs in on `auth.tnet.ge` (email or phone + password, invisible reCAPTCHA). **Verified live with the owner's real account (2026-10-15):** email + password sign-in succeeded with no SMS/email code, the session persisted in the browser profile and was reused on the next run, and a sample listing was prepared up to the pre-publish review (category found from live comparables, full category path selected, condition/price/title/description/required dropdowns filled from the draft, three photos uploaded cover first and verified in order) without clicking publish. Sign-in passes through single-sign-on hops on sibling auth hosts (`auth.myauto.ge/?AccessToken=…`), which are allow-listed; the live form uses react-select dropdowns, `fast-option` rows, hidden button-styled radios (selected state is an `active` class) and an uploader that shows a multi-file selection out of order, so photos are uploaded one at a time and the gallery order is checked. A real submission receipt remains unverified; the app must still discover new required attributes during use and fail closed. Video upload support could not be established from public material or an authenticated uploader; stage one is photo-only, with video an optional later extension.

## Verification and release

```sh
corepack pnpm build
corepack pnpm exec tsx --test tests/access.test.ts tests/codex.test.ts tests/manual.test.ts tests/secret-files.test.ts
corepack pnpm test:ui
corepack pnpm security:check
corepack pnpm audit --prod
# Python is only needed for the isolated HTTP smoke check, not for running the app:
python -m pytest -q -m smoke
```

Results: backend tests including the agent login/OTP/session-reuse/credential-handling suite (`tests/agent.test.ts`), 4 production UI tests, build/typecheck, private-data checks, clean production dependency audit, and the isolated smoke check passed. Fixture tests fulfill simulated marketplace requests locally; no real test listing was published. The native Codex probe and private-browser probe are separately identified from fixture verification. Do not repeat the full backend suite as part of this handoff; the manager's deployment validation owns its final run.

The [execution report](docs/EXECUTION_REPORT.md) retains changed files, exact checks, blockers, icon provenance, release preparation and activation steps. The prepared artifact is local and has not been deployed or pushed.
