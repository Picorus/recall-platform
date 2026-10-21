# RECALL "Night Signal" — brand colours and type (decided 22 Oct 2026)

Replaces the amber/tarmac/chalk palette (amber was too close to Rapido yellow). Feel: a lit screen on a dark road. Deep midnight surfaces, ONE electric volt-lime accent. None of these is the main colour of Swiggy, Zomato, Ola, Uber, Rapido, Zepto, Blinkit, PhonePe, Paytm.

## Core colours
| Name | Hex | Role |
|---|---|---|
| volt | #C8F54A | The one accent: main button, live state, the one key number, the logo symbol. Text on it is always midnight (15.3:1). Never volt text on light grounds. |
| midnight | #0A0E17 | Brand dark: dark grounds, all on-bike screen grounds, app bars. |
| paper | #F4F5F0 | Brand light: light grounds, print. |
| graphite | #161B26 | Raised dark surface (cards on dark, screen frame). |
| ion | #6E7BFF | Data and maps on dark (5.5:1 on midnight). |

## Themed UI tokens (light / dark)
| Token | Light | Dark | Use |
|---|---|---|---|
| surface-0 | #F4F5F0 | #0A0E17 | Page ground |
| surface-1 | #FBFBF8 | #121723 | Cards |
| surface-2 | #E7E9E2 | #161B26 | Wells, table bands |
| line | #DADDD4 | #262D3B | Hairlines |
| line-strong | #767C88 | #5B6272 | Control borders (3:1+) |
| ink | #0E121B | #F4F5F0 | Main text (17:1) |
| ink-muted | #3D4350 | #A3AAB8 | Secondary text (7:1+) |
| ink-subtle | #5B6272 | #8A909C | Captions on surface-0/1 (5.6:1+) |
| brand | #C8F54A | #C8F54A | Brand fills |
| on-brand | #0A0E17 | #0A0E17 | Text on brand |
| brand-ink | #4F6B00 | #C8F54A | Accent as text (5.6:1 light) |
| brand-soft | #EEFBC9 | #26310D | Accent wash |
| data | #3B47D9 | #6E7BFF | Second series, links, maps |
| data-soft | #E6E8FF | #1B2150 | Data wash |
| go | #137A4E | #3DDC97 | Done, paid, delivered |
| go-soft | #DDF5E9 | #0F2E22 | |
| stop | #C2341B | #FF6B4A | Errors, shortfalls |
| stop-soft | #FDE5DF | #3A1710 | |
| focus | #0E121B | #C8F54A | Focus ring |

## Old → new mapping (for recolouring files)
#FFB81C→#C8F54A · #FFC94D→#C8F54A · #8A5C00→#4F6B00 · #5E3F00→#3A4F00 · #FFE7A8→#EEFBC9 · #3A2E10→#26310D · #0E1013→#0A0E17 · #22262C→#161B26 · #181B20→#121723 · #2E333B→#262D3B · #F5F3EC→#F4F5F0 · #FFFDF8→#FBFBF8 · #EDEAE1→#E7E9E2 · #E2DED3→#DADDD4 · #8E949C→#767C88 (borders on light) · #14171B→#0E121B · #4A4E55→#3D4350 · #5E6268→#5B6272 · #B9BEC5→#A3AAB8 · #3E5C76→#3B47D9 · #8FA3B8→#6E7BFF · #E6ECF2→#E6E8FF · #17784E→#137A4E · #4CC38A→#3DDC97 · #E3F2EA→#DDF5E9 · #C6372C→#C2341B · #FF7A6E→#FF6B4A · #FBE3E0→#FDE5DF

## Type
- Headings and text: **Anek Latin** (Google Fonts, variable wdth 75–125, wght 100–800). Headlines 700–800 at wdth 110; text 400/500/600 at wdth 100.
- Telugu and Hindi: **Anek Telugu**, **Anek Devanagari** (same family, so bilingual pages look like one voice).
- Numbers in tables, IDs, bills: **IBM Plex Mono** 500.
- Google Fonts link: https://fonts.googleapis.com/css2?family=Anek+Latin:wdth,wght@75..125,100..800&family=Anek+Telugu:wdth,wght@75..125,100..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap
- No Inter, no Space Grotesk.

## Logo
Keep the **Afterimage** symbol (screen block + two shrinking echoes trailing left) and the drawn RECALL wordmark — same geometry — recoloured: symbol volt; wordmark midnight on paper, paper on midnight; all-midnight on volt. App icon: volt symbol on midnight.

## Character
6px corners on controls, 14px on cards, 20px on hero panels and screen frames, 999 pills. 1px lines. Data in mono. One volt element per view. Real Hyderabad photos, no stock illustration, no gradients or glows.
