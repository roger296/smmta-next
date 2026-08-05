# Auto-Stock — User Manual

**For head bakers and venue teams taking part in live testing.**

Auto-Stock is Big Bakes' stock-control system. It keeps track of what
ingredients each venue has, what arrives from suppliers, and what gets used in
each baking session — so we can see food cost, wastage and what needs
reordering, per site, without anyone counting things twice on paper.

You need three things from this manual: how to sign in, how to set your site,
and the three jobs you'll do each day. Everything else is detail you can come
back to.

---

## 1. Before you start

**What you'll use**

| | |
|---|---|
| Web address | `https://stock.thebigbakes.com` |
| iPad sign-in page | `https://stock.thebigbakes.com/pin-login` |
| Desktop sign-in page | `https://stock.thebigbakes.com/login` |

Auto-Stock runs in a web browser — there's no app to install. On the venue
iPad, open Safari and go to the iPad sign-in page above. Tap the **Share**
button, then **Add to Home Screen**, so it opens full-screen like an app.

**This is live testing, so please read this bit**

You are using the real system with real stock figures. What you enter is
recorded and will be looked at. But three things are deliberately switched off
while we test:

- **Nothing is sent to Xero.** The accounting entries are worked out and
  logged, but not posted. Nobody's books move because of what you enter.
- **Session details do not yet come across from BumbleBee automatically.**
  That's why you have to type a Session ID by hand (see §5.2), and why the
  "awaiting consumption" list on the Dashboard is usually empty.
- **Some overnight jobs are run by hand**, by the office, rather than on a
  timer. If a reorder suggestion doesn't appear straight away, that's why.

None of that changes what you should do. Enter what actually happened, as
accurately as you can. The point of the test is to find out where the system
makes that hard.

---

## 2. Signing in

### On the venue iPad — PIN

1. Open `https://stock.thebigbakes.com/pin-login`.
2. Tap your PIN on the keypad. **C** clears it, **⌫** deletes one digit.
3. Tap **Sign in**.

You'll land on the Dashboard. You stay signed in for **12 hours**, then you'll
need to tap your PIN again — so expect to sign in roughly once a shift.

If it says **"Incorrect PIN"**, the PIN cleared itself; try again carefully. If
it says **"Could not reach the server"**, that's the network, not your PIN —
check the iPad's Wi-Fi.

**Your PIN is yours.** Don't share it and don't write it on the iPad. If you
think someone else knows it, tell the office and we'll issue a new one.

### On a desktop or laptop — email and password

1. Open `https://stock.thebigbakes.com/login`.
2. Enter your email address and password, and click **Sign in**.

This keeps you signed in for 30 days. Use this when you're doing office work —
looking at reports, checking reorder levels — rather than working in the
kitchen.

> **A note on what you can see.** During testing, every account can reach every
> page and every site's figures. There are no restricted logins yet. Please
> stay in the pages this manual covers, and don't change settings, recipes or
> product records unless the office has asked you to.

---

## 3. Set your site — do this first, once per iPad

**This is the single most important step in the manual.** Auto-Stock files
everything you enter against whichever site the device is set to. It does not
work this out from your PIN. Get it wrong and your counts land on another
venue's books.

1. Sign in and stay on the **Dashboard**.
2. At the top of the screen, find the **site selector** in the header bar.
3. Choose your venue — Birmingham, Liverpool, London East, London South or
   Manchester.

The iPad remembers this, so you only do it once per device — but **check it
every time**. Each of the three job screens shows the site name at the top:

- **Goods in** — the title reads `Goods in — Manchester`
- **Stock-take** — the site name is the large heading
- **End of bake** — the site name is the large heading

**If that name is not your venue, stop.** Tap the back arrow (top left) to
return to the Dashboard, change the site in the header, then go back in. Don't
carry on and fix it afterwards — there is no undo on the iPad screens.

---

## 4. Finding your way around

Sign in and you're on the **Dashboard**, which shows three tiles: consumption
statements filed today, the value of stock held, and items that need ordering.
Don't worry if a tile says it isn't ready — that's expected during testing.

The menu down the left-hand side has everything else. The three you need are:

| Menu item | What it's for |
|---|---|
| **Goods in** | Booking in a delivery |
| **End-of-session** | Recording what a baking session used |
| **Stock-take** | Counting what's actually on the shelf |

On a phone or a narrow iPad, tap the **☰** button in the top-left to open that
menu.

The other menu items are for the office. You're welcome to look, but please
don't change anything there during testing.

---

## 5. The three daily jobs

### 5.1 Goods in — booking in a delivery

**Do this when a delivery arrives, before it's put away.** Booking it in is
what adds the stock to the system.

1. Open **Goods in** from the menu. Check the site name in the title.
2. The cursor sits in the **"Scan / enter barcode or name"** box. Scan the
   barcode, or type the product name and press Enter (or tap **+ Add**).
3. The product appears as a line, with a quantity of 1.
   - If you get **"No product for …"**, that item isn't in the catalogue yet.
     Note it down and tell the office — don't try to force it in as something
     else.
4. Set the quantity you actually received, in the units you buy it in — sacks,
   cases, boxes, not kilograms:
   - **−** and **+** step by one.
   - Tap the **big number** to type an exact figure on the keypad.

   Under the product name you'll see what that converts to in stock units, for
   example `= 16 kg · £12.50/sack`. Use that to sanity-check yourself.
5. Tap the **£** button on a line to open its details:
   - **Unit cost** — the price per purchase unit. It's pre-filled with the
     expected cost. **If the delivery note says something different, change
     it.** This is how food cost stays accurate.
   - **Batch code** and **Use by** — these appear only for products that need
     them. A line showing an orange **`batch needed`** badge is not finished.
   - **Remove line** takes a line off; **Save** closes the panel.
6. Repeat for everything on the delivery.
7. Tap **Book in N lines**.

You'll see **"Booked in"**. The lines clear, and the stock is now on the
system.

**Watch out for**

- Book in **what actually arrived**, not what was ordered. Short deliveries and
  substitutions are exactly what we need the test to catch.
- Enter each delivery once. If you're unsure whether it went through, check
  **Stock by site** in the menu rather than booking it in again.
- A line with an orange **!** dot is missing something — usually a batch code.

### 5.2 End of bake — recording what a session used

**Do this at the end of each baking session, while you can still see what's
left on the benches.** This is the most important record in the system: it's
what tells us the true cost of a session.

**Step one — set up the session**

1. Open **End-of-session** from the menu. Check the site name.
2. **Cake baked** — tap the cake from the tiles.
3. **Number of Regular Tables** — tap **Tap to enter** and key in the number.
   Tables, not guests.
4. **Number of Gluten Free Tables** and **Number of Vegan Tables** — these
   start at 0. Change them only if you had any.
5. **Date** — today by default. Change it only if you're catching up on a
   previous day.
6. **Session ID** — the BumbleBee session id for this sitting. Get this from
   BumbleBee or from the office rota. **Don't invent one** — it's what links
   this record to the booking.
7. **Your name (who baked this)** — type your name.
8. Tap **Load ingredients →**.

If you see **"No recipe found for that cake / date"**, that cake has no recipe
loaded for that date. Tell the office; don't carry on with a different cake.

**Step two — confirm what was actually used**

You'll get one row per ingredient, pre-filled with what the recipe *expected*
for that number of tables. Your job is to correct the ones that are wrong.

Each row shows `Expected 4 kg · 0.5 kg per table` underneath the name, so you
can see what one table's worth is.

For each ingredient that didn't go to plan:

- **−** and **+** step by one unit.
- **Table−** and **Table+** step by exactly one table's worth of the recipe.
  Use these — they save you doing the arithmetic.
- Tap the **big number** to type an exact figure.

A **Δ** badge appears when your figure differs from expected. That's not an
error; it's the whole point.

**Two ways to answer.** Each row has a button reading either
**`ENTERING: AMOUNT USED — tap to switch`** or
**`ENTERING: WHAT'S LEFT — tap to switch`**. Tap it to change which question
you're answering:

- **Amount used** — how much went into the bake. The normal way.
- **What's left** — how much is still in the tub. Easier for things you can
  see the remainder of, like a part-sack of flour. The system works out the
  usage from the stock it has on record.

Read that button before you type. The number means opposite things in the two
modes, and switching modes clears the figure you'd typed for the other one —
deliberately, so a "used" figure can never be read as a "left" figure.

**Recording wastage.** Tap the **⚠** button on a row:

1. Key in how much was wasted.
2. Tap a reason — **Spillage**, **Burnt**, **Dropped**, **Over-portioned**,
   **Off / expired** — or type your own.
3. Tap **Save**. (**Clear** removes it.)

Wastage is recorded separately from usage, so please do log it. It isn't held
against anyone — it's how we find out which ingredients we're losing and why.

**Step three — submit**

Tap **Submit consumption**. You'll see **"Consumption recorded"** and the form
resets, ready for the next session.

The button stays greyed out until the site, Session ID, your name and at least
one ingredient line are all filled in.

### 5.3 Stock-take — counting what's on the shelf

**Do this when the office asks — usually weekly or monthly.** A stock-take
compares what's physically there against what the system thinks, and corrects
the difference.

1. Open **Stock-take** from the menu. Check the site name.
2. Choose **what you're counting**:
   - **Full count** — everything. The periodic count.
   - **Cycle count** — a rolling subset.
   - **Category** — one group of items.
3. Tap **Start count**.

You'll get a list of items with the system's figure shown as
`Book: 12 kg` under each name. The bar across the top tracks
`N / M counted` as you go.

For each item:

- **−** and **+** step by one.
- Tap the **big number** to type an exact figure.
- **0** records a genuine zero. **Use it** — an item you counted and found
  none of is different from one you skipped, and the system needs to know
  which.
- **½** unlocks part-units — quarter, half, three-quarters — for a part-used
  sack or tub.

A **Δ** badge appears where your count differs from the book figure.

Use the **Search items…** box to jump to something, and the **Not counted**
chip to see only what you've still got left to do.

**Finishing**

- **Save counts** — saves your progress without changing any stock. Tap this
  as you go, especially before a break. You can come back and carry on.
- **Approve & true-up** — finishes the count. **This corrects the stock
  figures** to match what you counted, and can't be undone from the iPad.

Only tap **Approve & true-up** when you've counted everything in scope and
you're confident in the figures. If a variance looks wrong, recount before
approving, not after.

---

## 6. Working offline

The three job screens keep working if the Wi-Fi drops. If you submit while
offline, you'll see **"Saved offline — will sync"** instead of the usual
message. Your work is held on the iPad and sent automatically when the
connection comes back.

The **sync pill** at the top right of each screen shows where you are.

Two things to know:

- **Don't clear Safari's data, and don't hand the iPad on, while something is
  waiting to sync.** Unsent work lives on that device.
- **Don't re-enter something because you're unsure it went through.** Each
  submission is tagged so a repeat won't be double-counted — but a genuine
  second entry will be. Check **Stock by site** first if in doubt.

---

## 7. When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "Incorrect PIN" | The PIN wasn't recognised | Try again. If it keeps failing, ask the office for a new one |
| "Could not reach the server" | Network problem | Check Wi-Fi and try again |
| "No product for …" | Item isn't in the catalogue | Note it and tell the office. Don't substitute another product |
| "No recipe found for that cake / date" | No recipe loaded for that cake on that date | Tell the office. Don't record it as a different cake |
| Wrong site name at the top | The iPad is set to another venue | Go back to the Dashboard, change the site in the header (§3) |
| Dashboard tile says it isn't ready | Expected during testing | Ignore it |
| A page you don't recognise | You've wandered off the tested routes | Tap **Dashboard** in the menu |

**If you're not sure — stop and ask.** A missing record is easy to add later. A
wrong record that's already corrected the stock figures is a lot more work to
unpick.

---

## 8. What we need from you during testing

You are testing the system, not just using it. Please tell the office about:

- Anything that took longer than it should have, or that you had to think
  twice about.
- Any wording on screen that was unclear or meant something different from what
  you expected.
- Anything you couldn't record accurately — an ingredient not on the list, a
  unit that didn't match how you actually buy or use it, a situation the form
  didn't have a place for.
- Any figure that looked wrong.
- Anything you did by accident, and what you were trying to do instead. These
  are the most useful reports of all — please don't hide them.

For each one, note **the date and time**, **your site**, **which screen**, and
**what you were trying to do**. That's enough for us to find it in the logs.

---

## 9. Quick reference

**Every shift**

1. Sign in with your PIN.
2. Check the site name at the top of the screen is your venue.

**When a delivery arrives** → **Goods in** → scan or type each item → set the
quantity received → check the unit cost against the delivery note → add batch
codes where asked → **Book in**.

**At the end of a baking session** → **End-of-session** → cake, tables, date,
Session ID, your name → **Load ingredients** → correct what differs, log
wastage → **Submit consumption**.

**When asked to count** → **Stock-take** → choose the scope → **Start count**
→ count everything, using **0** for genuine nils → **Save counts** as you go →
**Approve & true-up** only when you're finished and confident.

**Never**

- Never carry on when the site name at the top is wrong.
- Never invent a Session ID.
- Never approve a stock-take you haven't finished.
- Never share your PIN.
