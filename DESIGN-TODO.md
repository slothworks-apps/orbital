# Design tuning — zbývající práce

Stav k 2026-09-15 (po druhé ladicí vlně). Reference = export v
`design/Orbital_ celestial agent dashboard/Orbital.dc.html` — obsahuje doslovné
inline CSS všech artboardů (1a–1h); hodnoty brát VŽDY odtud, ne z oka.
Artboardy se renderují přes `npx serve -l 8931` v té složce + Playwright
element screenshot `target: [id="1a"]` (pozor: `#1a` jako CSS selektor nefunguje,
id začíná číslicí).

## Neověřeno v prohlížeči (hotové v kódu, testy zelené)

Poslední vlna commitů (`15a2bb1`, `3e2b32c`) prošla testy (web 354, server 75)
a typechecky, ale NEPROBĚHLA vizuální kontrola proti artboardům:

- Settings přestavěný na layout 1h (řádky 1fr/320px, nav 240px, compact ModeCards,
  segmentový lineage control, toggle 32×18, sans select „30 min idle").
- Sidebar collapse: obě vrstvy (expanded 300px / rail 56px) v jednom Panelu,
  crossfade + width 420ms `cubic-bezier(.2,.8,.2,1)` dle exportu.
- Chips podle 1a: sans 11px/600, neutrální border, hue jen v tečce;
  aktivní = hue border .4 + hue bg .1 (Chip.tsx), „All" styl.
- Search input 1a (tmavý kontejner, ⌕, „Search sessions", ⌘K chip).
- New session CTA: size="lg" + gap-2 (přesný padding/gap z exportu).
- Přesný akcent `--color-accent: #59e4f3` (= oklch(85% .12 205)).
- Per-tag AUTO-TAG RULES: výběr tag karty vlevo filtruje pravidla vpravo,
  swatche+Delete jen na vybrané kartě, + Add rule cílí vybraný tag,
  reorder v rámci tagu (Tominův požadavek nad rámec statického 1e).

→ První krok příště: read-only Playwright průchod (main, collapse animace,
New session, Settings, Tags & rules) a srovnat s ab-1a/1d/1e/1h.

## Nedodělané / vědomé odchylky

1. **Tags & rules layout** — logika per-tag hotová, ale panel je pořád menší
   modal; 1e má velký dvousloupcový panel s hlavičkou (back ‹, „saved · just
   now"), drag-grip ⋮⋮ u pravidel (drag reorder odloženo — jen šipky),
   „+ Add rule" jako dashed řádek přes šířku tabulky, PREVIEW footer řádek
   se šipkou a výsledným chipem.
2. **Working planeta** — chybí tenký vnitřní rotující 4-obloukový prstenec
   (repeating-conic 60°/90°, reverse spin 60s, inset -13px; viz 1f).
3. **Detail panel** — usage grid (INPUT/OUTPUT/CACHE READ) + context bar se
   ukazuje jen u web sessions s usage daty; terminal sessions nemají nic
   (data neexistují — případně placeholder). Reply composer proti 1b
   nevizuálně ověřen po změnách Buttonu.
4. **Settings** — General/Permissions/Appearance/Shortcuts jsou disabled
   placeholdery (spec deferral); verze má jen řádek `orbital x.y.z` (design má
   i `claude-code x.y`); lineage chain ilustrace zjednodušená (statická,
   caption „older stay in history" místo dynamického „+4 in history");
   idle options jen 15/30/60 min (design má i „2 h idle" a „Never — only on
   Clear" — vyžaduje server podporu).
5. **New session dialog** — Browse… tlačítko vědomě chybí (v1), šířky vs 1d
   neměřeny po posledních změnách.
6. **Stop/Clear dialogy** — nevizuálně ověřeny po zavedení warning/cta
   variant Buttonu a novém Dialog chromu.
7. **Rules tabulka** — na úzkém okně se může ořezávat Delete sloupec
   (horizontální scroll je stylovaný, ale ideál je responzivnější grid).
8. **Měsíce** — stavy materializing/idle/needs_input nedosažitelné, dokud
   web sessions neposílají subagent WS eventy (dřívější follow-up v paměti).

## Užitečné drobnosti

- Screenshoty poslední kontroly: `~/Projects/slothworks/.playwright-mcp/`
  (ab-1a…1h = artboardy, live4-* = poslední stav appky).
- Titulky sessions: server čistí CLI obaly (`cleanTitle` v
  `server/src/transcript/parser.ts`); indexer si při startu sám přeindexuje
  řádky s noise titulky.
- Zákazy: nespouštět sessions/neposílat prompty (token burn), read-only
  browser smoke OK, nezabíjet Tominovy dev servery.
