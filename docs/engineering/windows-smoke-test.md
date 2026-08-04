# Windows smoke test

PageVault's CI runs on Linux and I develop on macOS. Until someone runs this, nobody has
stood the installed npm package up on **native Windows** — so that is what this page is for.
It is a protocol for a person with a Windows machine and about 45 minutes.

You do not need to be a developer, and you do not need anything installed beforehand. Every
command is written out. What I need back is not a verdict — it is *what actually happened*,
especially the parts that went wrong.

**A failure here is a successful test.** If something breaks, that is the finding. Copy the
error and move on to the next step where you can.

---

## Ground rules

**1. Use PowerShell, not WSL.** If you have Windows Subsystem for Linux, do not use it. WSL is
Linux, and Linux is already tested on every commit — running there would tell me nothing new.
Open **Windows PowerShell** or **Windows Terminal** from the Start menu.

**2. Use one window for the whole test.** Step 4 sets a variable that only lives in the window
where you set it. Close the window and later steps fail in confusing ways. If you do close it,
go back and redo step 4.

**3. Paste errors verbatim.** Do not summarize or clean up red text. The exact wording is the
evidence — "it failed" tells me nothing, `Bad escaped character in JSON at position 16` tells
me everything.

---

## What you need

- Windows 10 or 11.
- Nothing installed in advance. Step 1 gets you there.
- A Cloudflare API token. **I will send you one** — you do not need a Cloudflare account of
  your own and you will not have to sign up for anything.

---

## Step 1 — Install Node.js

Node is the thing PageVault runs on. It also brings `npm`, the installer used in step 2 — they
arrive together, so this one download covers both. You very likely do not have it.

Check first:

```powershell
node --version
```

If it prints `v22.` or higher, skip to step 2. Anything else — `v20`, `v18`, or
`'node' is not recognized` — means you need to install it:

1. Go to <https://nodejs.org>.
2. Download the **LTS** build (the one on the left, the recommended one).
3. Run the installer and take every default. Do not change the install location.
4. **Close PowerShell completely and open a new window.** The installer edits your PATH and an
   already-open window will not see it.

Then confirm both:

```powershell
node --version
npm --version
```

**Expected:** `v22.` or higher, and a version number for npm.

If `node` works but `npm` does not, stop and tell me — that is worth knowing on its own.

- [ ] Did you already have Node, or did you install it? `______`
- [ ] `node --version`: `______`
- [ ] `npm --version`: `______`

---

## Step 2 — Install PageVault

```powershell
npm install -g pagevault
```

This is the real thing — the same command anyone in the world would run. It may take a minute
and may print warnings; warnings are fine, errors are not.

> **If I told you to test a pre-release build**, I will have sent you a `.tgz` file instead.
> In that case run this rather than the command above, keeping the quotes:
>
> ```powershell
> npm install -g "$env:USERPROFILE\Downloads\pagevault-VERSION.tgz"
> ```

Check the command exists:

```powershell
pagevault --version
```

**Expected:** a version number, nothing else.

If you get `pagevault : The term 'pagevault' is not recognized`, npm's global folder is not on
your PATH. Run `npm config get prefix` and tell me what it prints — do not try to fix it. That
is a real finding, and it is one of the things this test is looking for.

- [ ] Install succeeded
- [ ] `pagevault --version` printed: `______`

---

## Step 3 — Check the help screen

```powershell
pagevault help
```

**Expected:** a list of commands, in color, with `✓` `→` `!` symbols where relevant.

This step is about how it *looks*, so tell me:

- [ ] Is the text colored, or all one color?
- [ ] Do the `✓ → !` symbols render, or do you see boxes / question marks / garbage like `âœ"`?
- [ ] Which terminal are you in — Windows Terminal, or the older blue PowerShell window?

Now check it behaves when redirected to a file. Note the `*>` — PageVault sends human-readable
output to a separate channel from its machine-readable output, and `*>` captures both:

```powershell
pagevault status *> out.txt
notepad out.txt
```

- [ ] Does `out.txt` read cleanly, or is it littered with `←[36m`-style junk?

---

## Step 4 — Set the state folder (this one matters)

```powershell
$env:PAGEVAULT_HOME = "$env:USERPROFILE\Page Vault Test"
```

That folder name has a space in it **on purpose**. There is a known bug where a space in the
path breaks the deploy, and this guarantees you hit it whether or not your Windows username has
one. It also keeps this test's files in one folder you can delete later.

Confirm it took:

```powershell
echo $env:PAGEVAULT_HOME
```

**Expected:** something like `C:\Users\yourname\Page Vault Test`.

> Remember: this lasts only as long as this PowerShell window.

- [ ] Variable set and printed correctly

---

## Step 5 — The API token

I will send you a Cloudflare API token separately. It is a long string of letters and numbers.

Copy it to your clipboard and go straight to step 6, which will ask you to paste it.

**Do not** try to save it to a file with `echo` or `>`. PowerShell writes those files in an
encoding the tool cannot read, and you will get a confusing "no token" error even though the
file looks correct in Notepad. Pasting at the prompt is the safe path — and it is the path I
want tested.

Treat the token like a password: do not paste it into anything else, and tell me when you are
done so I can delete it.

- [ ] Token received

---

## Step 6 — Stand up a deployment

```powershell
pagevault init --tier public
```

It will ask you some questions. Answers:

- **Cloudflare API token** — paste the one from step 5.
- **Owner email** — your own email address.
- **Hostname** — leave it blank / accept the default. There is no domain involved; it will use
  a free `workers.dev` address.
- **Anything else** — accept the defaults.

It will then deploy. This is the step most likely to fail, and the most valuable one.

**Expected:** it finishes and prints a URL.

**If it fails, I need the whole thing.** Scroll up and copy everything from where you ran the
command to the end. Specifically watch for any of:

- a message about `wrangler.generated.jsonc` or invalid JSON
- an error naming a truncated path like `C:\Users\Your` (cut off at a space)
- `Bad escaped character in JSON`

Those are the three failures I am actively hunting.

- [ ] `init` succeeded / failed (circle one)
- [ ] URL printed: `______`
- [ ] If it failed, error pasted below

---

## Step 7 — Check the deployment

```powershell
pagevault status
pagevault verify
```

`status` is local and just reads a config file. `verify` talks to the live deployment and runs a
full publish → rename → read → delete round-trip.

**Expected:** both come back with checkmarks and no red.

- [ ] `status` clean
- [ ] `verify` clean

---

## Step 8 — Publish something and open it

Create a test file:

```powershell
Set-Content -Path smoke.html -Encoding utf8 -Value '<html><body><h1>Hello from Windows</h1><p>If you can read this, it worked.</p></body></html>'
```

Publish it with a public link:

```powershell
pagevault publish .\smoke.html --title "Windows smoke test" --public
```

**Expected:** one URL printed and nothing else.

Open that URL in a browser.

- [ ] URL printed: `______`
- [ ] The page opens and says "Hello from Windows"
- [ ] Anything odd about how it looks?

---

## Step 9 — The everyday commands

Run these in order. They are the commands someone would use daily.

```powershell
pagevault list
pagevault portals
```

`list` shows a table with your document's **id** in it. Copy that id and use it below in place
of `<id>`:

```powershell
pagevault read <id>
pagevault link <id>
pagevault edit <id> --title "Renamed from Windows"
pagevault list
```

**Expected:** `read` prints the document, `link` prints its URL, `edit` succeeds, and the second
`list` shows the new title.

- [ ] All five commands worked
- [ ] Any that did not — which, and what did it say?

---

## Step 10 — Export (a known limitation)

```powershell
pagevault export
```

**Expected:** it writes a folder and prints the path. Open `index.html` inside that folder in a
browser — it should be a browsable index of your documents.

Then:

```powershell
pagevault export --zip
```

**Expected — this is not a bug:** Windows has no `zip` command, so it should leave the folder in
place and print a note saying so. What I need to know is whether it **explains itself clearly**
or just looks broken.

- [ ] `export` produced a folder that opens in a browser
- [ ] `export --zip` — what exactly did it say?

---

## Step 11 — Tear it down

```powershell
pagevault destroy
```

It will ask you to confirm. Say yes. This deletes the deployment and its data.

Then clean up locally:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\Page Vault Test"
npm uninstall -g pagevault
```

Tell me when you are done so I can delete the token.

- [ ] `destroy` worked
- [ ] Local cleanup done
- [ ] Told me to kill the token

---

## What to send back

Copy this, fill it in, send it over. Short answers are fine.

```
Windows version:
Terminal used (Windows Terminal / PowerShell / other):
Did you already have Node, or install it in step 1?
Does your Windows username have a space in it? (yes/no)

Step 1  Node + npm install:
Step 2  npm install -g pagevault, then --version:
Step 3  colors, symbols, redirected output:
Step 6  init:
Step 7  status + verify:
Step 8  publish + open in browser:
Step 9  list/read/link/edit:
Step 10 export + export --zip:
Step 11 destroy + cleanup:

Anything that was confusing, even if it worked:

Full text of any error (paste raw, do not tidy it up):
```

That last question is the one I care about most. A command that technically succeeded but made
you guess what to do next is a defect too.

---

## For the maintainer

**Run it yourself first, then hand it over.** The two runs are not the same test and both are
worth having:

| Run | Installs from | What it proves |
| --- | --- | --- |
| Mine, on my own Windows box | `npm pack` tarball | the unreleased fixes work on Windows at all |
| A stranger's, after release | `npm install -g pagevault` | the *published* artifact installs and runs on a machine with nothing on it |

The second is the higher-fidelity test and cannot be faked — my machine has Node, a PATH full of
tooling, and years of accumulated state. Someone starting from a clean Windows install is the
only way to find out whether step 1 and step 2 actually work.

**Before sending the token, check the account it belongs to:**

- **It should be empty.** Step 11 runs `pagevault destroy`. Point a tester at an account holding
  a deployment you care about and that command will take it down. Use a clean test account.
- **Its `workers.dev` subdomain must be enabled.** Step 6 deploys at rung 1, which *is* a
  workers.dev address. Secured deployments call for disabling that subdomain, so an account
  previously used for a Secured setup will fail here — with a specific error naming it, at
  least. Either re-enable it or switch the tester to rung 2 with a hostname.
- **Scope the token to three account permissions** — Workers Scripts (Edit), Workers KV Storage
  (Edit), Account Settings (Read). That is all rung 1 needs. Mint it fresh for the test, and
  delete it when the tester reports back rather than reusing one you rely on.

Why the protocol is shaped the way it is:

- **Native Windows, not WSL.** WSL2 is Linux and is covered by CI on every commit. The untested
  surface is PowerShell, NTFS, `npm install -g` bin shims, and `npx wrangler` on Windows.
- **Step 1 assumes nothing.** A tester who is not a developer will not have Node, will not know
  npm ships with it, and will not know an open terminal misses a PATH change. Each of those is
  called out because each one silently ends the test otherwise.
- **`PAGEVAULT_HOME` with a space** (step 4) makes the unquoted-path deploy bug reproducible on
  any machine, instead of only on profiles like `C:\Users\First Last`.
- **Steps 6 and 7 are the payload.** Everything before them is setup; everything after checks
  the portable surface, which is `fs` + `fetch` and was never in much doubt.
