# loop-extract-emails

Loop's waitlist and email extractor.

After signing in with Google, `loop-extract-emails` will store all unique senders in the user's mailbox in [Cloudflare D1](https://developers.cloudflare.com/d1/).

## Developing

Once you've created a project and installed dependencies with `pnpm install`, start a development server:

```sh
pnpm dev

# or start the server and open the app in a new browser tab
pnpm dev -- --open
```

This might also prompt for Cloudflare authorization, as the dev server connects to the production D1 instance. If authorization doesn't work, consult the configuration in [`wrangler.jsonc`](./wrangler.jsonc).

## Building

To create a production version of the app:

```sh
pnpm build
```

You can preview the production build with `pnpm preview`.

> For deployment, a [Cloudflare Worker](https://workers.cloudflare.com/) is configured to automatically track the `main` branch.
