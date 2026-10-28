# Showing RECALL: the live demo

The live demo is the real RECALL software running on made-up data.
- The staff portal, the brand portal and the rider app are all there.
- 200 fake bikes ride around Hyderabad and their screens send in plays as real ones would.
- Every outside service (payments, WhatsApp, ID checks, …) is a stand-in: **no real money moves and no real message is sent.**

You open it in your browser. Nothing is installed on your computer.

Guides for each app (what each page is for, and a 5-minute script to follow):
- [Staff portal](guides/STAFF_PORTAL.md)
- [Brand portal](guides/BRAND_PORTAL.md)
- [Rider app](guides/RIDER_APP.md)

---

## Open the demo (GitHub Codespaces)

A Codespace is a computer in GitHub's cloud that opens in your browser.

### The first time (about 10–15 minutes, once)

1. Go to **github.com/Picorus/recall-platform** and sign in.
2. Click the green **Code** button, then the **Codespaces** tab.
3. Click **Create codespace on main**.
4. A code editor opens in your browser. Let it work. It installs everything and builds the websites. You will see text scrolling in the terminal at the bottom. You don't need to do anything.
5. When the terminal shows this box, the demo is ready:

   ```
   RECALL demo is running. Open the demo desk: …
   ```

6. A new browser tab opens with the **demo desk**. If it doesn't, click the **Ports** tab at the bottom, find **Demo desk (start here)** and click the little globe icon next to it.

### Every time after that (about 3 minutes)

1. Go to **github.com/codespaces**.
2. Click your RECALL codespace.
3. The demo starts by itself, fresh, with campaigns running today. Wait for the box above, then open the demo desk.

### The demo desk

The desk is your home page for the demo. It has:
- buttons for the **staff portal**, the **brand portal** and the **rider app**;
- the **staff sign-in**: four people, one password (`recall demo 2027`), and the 6-digit code of the moment (it changes every 30 seconds, like a real authenticator app);
- the **brand and rider sign-in numbers**. When you ask for a code on a portal, it appears on the desk within seconds, as if it had come by WhatsApp;
- **Right now**: bikes riding, screens reporting in, ads played since the start.

### Showing it to someone

- **On a call (easiest):** share your screen and click through. Each guide has a 5-minute script.
- **Letting them click around themselves:**
  1. In the codespace, open the **Ports** tab.
  2. Right-click each of the four ports (Demo desk, Staff portal, Brand portal, Rider app).
  3. Choose **Port visibility → Public**.
  4. Send them the demo desk's address.

  Anyone with that link can open it **while your codespace is running**. Everything in it is made up.

### Time of day

Campaigns run from 8 am to 2 am. If you start the demo between 11 pm and 8 am India time, it runs as if it were **6:30 pm that day**, so bikes are on the road and ads are playing. The desk shows the demo time.

### A bigger fleet

To show 2,000 bikes instead of 200:
1. In the terminal, press **Ctrl+C** to stop the demo.
2. Type `pnpm demo -- --bikes 2000` and press Enter.
3. The demo takes about 3 minutes to build.

To see 15,500 bikes (the full fleet), use the investor demo page: it plays back real simulator runs at 200, 2,000 and 15,500 bikes.

### Stopping, and what it costs

- **Close the tab.** The codespace stops by itself after 30 minutes without use. To stop it at once: github.com/codespaces → **⋯** → **Stop codespace**.
- **Free allowance:** your GitHub account includes 120 "core hours" a month, which is about **30 hours of the demo** (it uses a 4-core machine), plus 15 GB of storage. When the allowance runs out, GitHub stops the codespace. It doesn't charge you unless you add a payment method and raise the spending limit, which is ₹0 by default.
- **Not using it for weeks?** Delete the codespace (github.com/codespaces → **⋯** → **Delete**). Making a new one takes the 10–15 minutes again.

### If something goes wrong

| You see | Do this |
|---|---|
| "port … is in use" | A demo is already running in another terminal. Close that terminal, or press Ctrl+C there, then type `pnpm demo`. |
| "node_modules missing" or "tsx: not found" | Type `pnpm install`, then `pnpm demo`. (`pnpm demo` now does the install itself; this is for a codespace made before 28 Oct 2026.) |
| "the database is not running" | Type `pnpm services:up`, then `pnpm demo`. |
| A page says "Not from the admin site" or sign-in fails | Open the portals from the demo desk's buttons, not from an old bookmark (the address changes with each codespace). |
| Every link shows an error page | The browser could not sign in to the private ports. Ports tab → right-click each of the four ports → **Port Visibility → Public**, then open the demo desk with its globe icon. Everything in the demo is made up, and the links stop working when the codespace stops. |
| The demo desk tab did not open | Ports tab → **Demo desk (start here)** → globe icon. |
| Nothing works | Stop the codespace and open it again. The demo always starts fresh. |

---

## On a laptop (for a developer)

You need Docker and Node 22. Run `pnpm install`, then `pnpm demo`. Open http://localhost:4000.

## What is real and what is a stand-in

| Real (the code that will run RECALL) | Stand-in (until the accounts are opened) |
|---|---|
| Booking, prices, GST invoices, the money ledger, make-ups and refunds, plays counting, rider pay, reports, the fleet map, every staff, brand and rider screen | Payments (a "Pay" button on the demo desk), WhatsApp and SMS (codes shown on the desk), email, ID checks and e-sign (pass at once), payouts (marked sent), GST lookups, maps in reports, the screens themselves (fake bikes on real Hyderabad roads) |
