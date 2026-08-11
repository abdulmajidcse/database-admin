## What this changes

<!-- What the change does, and why. If it fixes an issue, "Fixes #123". -->

## How it was verified

<!-- Which of these you ran, and against which engine where relevant. -->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Tried it in a browser against a real engine
- [ ] Connector change: exercised against the real server, not only unit tests

## Checklist

- [ ] No connection names, hostnames, database names or credentials from my own
      setup are in the diff — real values belong in `.env`, placeholders in the code
- [ ] No `node_modules` copied into the image, and no change to the `127.0.0.1`
      port publish or the Host/Origin allow-list without explaining why
- [ ] Comments explain *why* where the reason is not obvious from the code
