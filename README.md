\# Polymarket Tail Hedge Scanner (Apps Script)



This project scans Polymarket markets and surfaces \*\*cheap “tail” outcomes\*\* that can be used as \*\*convex hedges\*\* against systemic / existential risk scenarios (e.g., inflation spikes, commodity shocks, political discontinuities).



It also estimates \*\*market overround\*\* (a proxy for “cost of insurance”) and \*\*annualizes\*\* it by time-to-resolution.



> ⚠️ Not financial advice. This is a tool for market microstructure exploration and risk thinking.



---



\## What problem this solves



If you want catastrophe / regime-shift protection, you typically want positions that:



\- cost little up front (small premium),

\- pay a lot in rare bad states,

\- don’t require timing (you “hold insurance”),

\- and can be diversified across failure modes.



Prediction market outcomes can provide that convexity, but it’s hard to find:

\- which outcomes are “cheap enough” to act like insurance,

\- and whether the market’s embedded “fee” is reasonable relative to time.



This scanner automates the discovery step.



---



\## Convex hedge logic (intuition)



A \*\*tail hedge\*\* is a bet that is designed to be:

\- \*\*negative carry\*\* most of the time (you expect to lose small amounts),

\- but \*\*large payoff\*\* in a specific extreme state.



In a binary market, buying a low-priced outcome (e.g., 0.05) has convexity:

\- you lose ~0.05 if it doesn’t happen,

\- you win ~0.95 if it happens.



That payoff shape resembles insurance.



\### Why “one-sided outcomes”, not “whole markets”

In multi-outcome markets (ranges / ladders), you can treat each outcome as a “tail bracket”.

The scanner lists \*\*individual outcomes\*\* (not just market-level stats) so you can pick the tails you actually want.



---



\## Overround: “how expensive is this market?”



For a market with outcomes \\(i = 1..n\\), we use best available \*\*asks\*\* \\(a\_i\\) and compute:



\- \*\*sum of asks available\*\*:  

&nbsp; \\\[

&nbsp; S = \\sum a\_i

&nbsp; \\]



\- \*\*overround (partial)\*\*:  

&nbsp; \\\[

&nbsp; \\text{overround} = S - 1

&nbsp; \\]



Interpretation:

\- If \\(S > 1\\), you cannot buy a full set of outcomes for $1; the excess is market friction / spread / fees / imbalance.

\- Overround is a useful proxy for “how expensive it is to get exposure”.



\### Coverage (important!)

Often some outcomes have no meaningful ask (illiquid). So the script reports:



\\\[

\\text{coverage} = \\frac{\\#\\text{outcomes with an ask}}{\\#\\text{outcomes total}}

\\]



Overround is only meaningful when coverage is reasonably high.



---



\## Annualized overround: “interest rate of the friction”



Overround is not the full story: paying 3% overround for a market that resolves in 1 week is very different from 3% for a market that resolves in 1 year.



So we compute:



\- \*\*days to resolution\*\* (from Gamma end/close/resolution fields)

\- \*\*overround per year\*\*:

&nbsp; \\\[

&nbsp; \\text{overround\\\_per\\\_year} = \\frac{\\text{overround}}{\\text{days\\\_to\\\_resolution}/365}

&nbsp; \\]



Interpretation:

\- Treat \*\*overround\_per\_year\*\* like an “implied interest rate” of market friction/cost.

\- Lower is better, all else equal.



---



\## What the script outputs



It writes to a Google Sheet tab named `tail\_scan` with:



\- `ask`: best executable ask price for that outcome

\- `overround\_partial (sum\_asks-1)`: market-level partial overround

\- `coverage`: share of outcomes with usable asks

\- `sum\_asks\_available`: sum of asks across outcomes with prices

\- `days\_to\_resolution`: days until resolution (if available)

\- `overround\_per\_year`: annualized friction proxy

\- `topic\_tags`: simple keyword tags (gold, btc, oil, rates, election, war)

\- plus market metadata (`volume`, `slug`, `question`, etc.)



The rows represent \*\*candidate tail outcomes\*\* within your ask bounds.



---



\## How to use it as a hedge finder



A practical workflow:



1\. \*\*Filter to the risk domains you care about\*\*  

&nbsp;  Use `topic\_tags` (gold / btc / oil / rates / election / war).



2\. \*\*Favor markets with decent coverage\*\*  

&nbsp;  E.g., coverage ≥ 0.5 or 0.75.



3\. \*\*Compare annualized cost\*\*  

&nbsp;  Sort by `overround\_per\_year` (ascending).



4\. \*\*Select tails that align with your protection goal\*\*  

&nbsp;  Example (not advice):

&nbsp;  - inflation / debasement: gold ↑, rates ↑

&nbsp;  - energy shock: oil ↑

&nbsp;  - panic / capital flight: BTC behavior depends on your thesis

&nbsp;  - political discontinuity: election / escalation outcomes



5\. \*\*Diversify across failure modes\*\*  

&nbsp;  Catastrophe hedging is about \*breadth\* more than precision.



---



\## Installation \& usage



\### Requirements

\- Google Sheets

\- Apps Script enabled

\- Access to Polymarket Gamma and CLOB public endpoints



\### Setup

1\. In your Google Sheet: `Extensions → Apps Script`

2\. Paste `Code.gs` contents

3\. Reload the spreadsheet

4\. Run from menu: `Polymarket → Scan tail outcomes (+ overround)`



\### Tuning parameters (key ones)

At the top of `Code.gs`:



\- `MIN\_ASK`, `MAX\_ASK`  

&nbsp; Controls how “tail-like” outcomes must be.

\- `MIN\_VOLUME`  

&nbsp; Use >0 to avoid dead markets and reach “macro” markets faster.

\- `MIN\_COVERAGE`  

&nbsp; Controls minimum completeness for overround computation.

\- `MAX\_PAGES`, `MAX\_SECONDS`  

&nbsp; Controls scan depth vs runtime.



---



\## Limitations (read this)



\- \*\*Overround is approximate\*\*  

&nbsp; We use best executable asks from `/prices` and compute partial overround under incomplete books.

\- \*\*Liquidity can be deceptive\*\*  

&nbsp; Some asks exist but are tiny size; execution at scale may move the price.

\- \*\*Time-to-resolution can be missing\*\*  

&nbsp; Some markets lack usable timestamps in Gamma; annualization will be blank.

\- \*\*Not all “cheap tails” are meaningful hedges\*\*  

&nbsp; Many cheap outcomes are just obscure events. The tool is a filter, not a thesis.



---



\## Repo workflow (optional but recommended)



This project is designed to be synced via `clasp`.



Typical workflow:

\- edit in Apps Script → `clasp pull` → commit/push

\- or edit locally → commit/push → `clasp push`



---



\## License



Choose a license if you want others to reuse it (MIT is common). Otherwise, keep it private.

