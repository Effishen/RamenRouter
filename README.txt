RAMENROUTER 0.2.0 - OFFLINE BROWSER EDITION

START
1. Extract the complete ZIP into one folder.
2. Double-click RamenRouter.html.
3. Keep the supplied HTML, JavaScript and CSS files together.

The application runs entirely in the browser. It does not need Java, an
installer, a local server, an account or an internet connection. Use a current
desktop browser with Web Worker support, such as Chrome, Edge or Firefox.
No browser security settings or command-line flags should need changing.

WHAT THIS EDITION IS
This is a new JavaScript PCB router using grid-based A* search, repeated routing
attempts, optional pad fanout and route checking. It is not the original
Freerouting 2.2.4 algorithm compiled for the browser, and it is not a complete
port of the historical 2.1.0 fanout implementation. Results can differ
substantially from both Freerouting versions.

The requested historical versions informed the design investigation. A
faithful browser port would require further work on the original engine.
This edition provides the separate, Java-free, double-click-HTML application.

WORKFLOW
Export a Specctra .dsn board from your PCB editor. Component placement, netlist
and routing rules must already be present in that board.

Open the DSN in RamenRouter, inspect the preview and selected routing options,
then start routing. Download the resulting .ses session and import it into the
PCB editor that created the DSN. A .dsn result is also available.

Refill copper zones and run the PCB editor's complete design-rule check after
import. Review any remaining connections or rule violations. The preview and
the browser engine's checks do not replace the PCB editor's complete checks.

DEFAULT SETTINGS
These are the first-run defaults. Your browser may remember later changes.

  Routing attempts:            12
  Time budget:                 30 minutes
  Smart search:                on
  SMD fanout:                  on
  Optimization:                on
  Via-in-pad override:         off
  Nominal trace-width checks:  always enforced

The time budget requests a stop; it is not an expected runtime. A board may
finish sooner or remain partly unrouted when the budget expires. A worker
that does not finish stopping is terminated after a further 30 seconds, and
that unfinished run has no checked route export. Imports have a two-minute
time budget with the same stop grace period. Increasing attempts or runtime
does not guarantee that every connection can be completed.

SMD fanout makes checked escapes from dense surface-mount pad rows before
routing other connections. Widely spaced pads may be left unchanged. Fanout
only allows that stage to be inspected separately. Fanout can help or hurt a
particular layout; compare it on and off when needed.

The router does not automatically narrow new traces below the imported net's
nominal width. A congested connection can therefore remain unrouted rather
than being completed with a narrower trace.

The via-in-pad override explicitly permits a change to imported via-placement
permissions. It is off by default. Enable it only for a board intended to use
that fabrication and assembly arrangement.

FILES AND PRIVACY
Board data is processed locally in the browser. The app does not upload boards
or call an external routing service. It reads files selected by you and saves
results through browser downloads. Your original DSN is not overwritten.

Each run starts from the original imported DSN. A new run replaces the previous
in-memory result; download it first if you want to keep it. To continue routing
an exported result, import that result's DSN as a new board.

Download any result you want to keep before closing or reloading the page.
The support folder contains application code; it is not an automatically
updated project directory or a background routing service.

STOPPING
Stop job asks the worker to finish its current operation and return the best
checked board. Wait for the completed stop before downloading the result.
Force stop terminates the worker immediately and discards unfinished work;
that run cannot produce a checked route export.

LIMITS
See VALIDATION.txt and tests/ for the measured checks and supported formats.

This is an initial independent routing engine. Grid resolution limits which
geometric routes can be discovered. It does not implement every Freerouting
feature, every Specctra constraint, or an equivalent push-and-shove engine.
An unsupported import should be reported explicitly; do not assume that an
unrecognized constraint has been honored. Read import warnings before routing.

Large or dense boards can use substantial browser memory and processing time.
Keep the page open during routing. This application does not promise that a
fully routed result is possible for every board.

SOURCE AND LICENSE
The shipped .js, .html and .css files are the editable application source.
No compilation or dependency installation is needed after editing them.
Reload RamenRouter.html to use changes.

RamenRouter is distributed under GNU GPL version 3 or later. See LICENSE and
THIRD-PARTY-NOTICES.txt for the full license and project provenance.
This is an independent application, not an official Freerouting release.
