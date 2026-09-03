/**
 * Material category definitions.
 *
 * The audit's biggest content gap: the site had 17 SKU pages and one
 * /shop, and no page that exists to answer "PETG filament UK". That
 * query pattern — material plus intent — carries far more volume than
 * any product name, because nobody searches "Landau PETG Pro" until
 * they already know us. Every established UK competitor runs this page
 * type.
 *
 * Group→material matching is by name because the storefront API doesn't
 * expose a material field on groups. Word-boundary matching, so "PLA"
 * can't match inside another token; ASA and ABS are matched
 * independently and never fall through to each other.
 *
 * The copy below is deliberately specific — print temperatures, what
 * each material is bad at, when to move up a range. Generic "PETG is a
 * popular filament" text ranks for nothing and helps nobody; the honest
 * "what it's bad at" paragraph is unusually effective in this market and
 * matches the voice already used across the site.
 */

export interface MaterialSection {
  heading: string;
  body: string[];
}

export interface MaterialDefinition {
  /** URL slug — the page lives at `/{slug}`. */
  slug: string;
  /** Short code as it appears in group names. */
  code: string;
  /** Display name. */
  name: string;
  /** Page H1. */
  title: string;
  /** Meta description. */
  description: string;
  /** One-line summary under the H1. */
  standfirst: string;
  /** Quick-reference print settings. */
  settings: Array<{ label: string; value: string }>;
  sections: MaterialSection[];
}

export const MATERIALS: MaterialDefinition[] = [
  {
    slug: 'pla',
    code: 'PLA',
    name: 'PLA',
    title: 'PLA filament — 1.75mm, 1kg spools',
    description:
      'PLA filament in 1.75mm, 1kg spools. Print settings, when to use it, and when to choose PETG instead. Vacuum-sealed, UK stock, same-day dispatch before 2pm.',
    standfirst:
      'The easiest material to print and the right default for most jobs. Rigid, dimensionally accurate, and forgiving of a badly tuned printer.',
    settings: [
      { label: 'Nozzle', value: '200–220 °C' },
      { label: 'Bed', value: '50–60 °C' },
      { label: 'Cooling', value: '100% after layer 2' },
      { label: 'Enclosure', value: 'Not needed' },
      { label: 'Drying', value: 'Rarely needed' },
    ],
    sections: [
      {
        heading: 'What PLA is for',
        body: [
          'PLA is the material to reach for when the part does not need to survive heat, sunlight or sustained mechanical load. Prototypes, display pieces, tabletop miniatures, enclosures that live indoors, jigs, and anything where dimensional accuracy matters more than toughness.',
          'It prints cooler than every other material we stock, does not need an enclosure, and warps so little that large flat parts are realistic on an open-frame printer. If a print fails in PLA, the cause is usually the printer rather than the filament — which is exactly why it is the right material to commission a new machine with.',
          'It is also the most dimensionally accurate material here. A part designed to a tolerance will come out closer to that tolerance in PLA than in ABS or TPU, because it shrinks less on cooling.',
        ],
      },
      {
        heading: 'What PLA is bad at',
        body: [
          'Heat. PLA begins to soften somewhere around 55–60 °C, which is a temperature a car interior reaches on a sunny day in Britain, never mind abroad. Anything that will sit on a dashboard, near a radiator, in a loft, or inside a warm enclosure should not be PLA.',
          'Sustained load. PLA creeps — under constant stress it slowly deforms rather than springing back. A bracket that holds a shelf will sag over months. Use PETG or ABS for anything load-bearing.',
          'Outdoors. UV degrades PLA and it becomes brittle. ASA is the material for outdoor parts.',
          'Impact. PLA is stiff but brittle: it snaps rather than bending. Parts that get dropped, clipped on and off, or flexed want PETG.',
        ],
      },
      {
        heading: 'Choosing between our PLA ranges',
        body: [
          'Standard PLA is the baseline and the cheapest way to print a lot of parts. PLA Basic is the same idea with tighter batch-to-batch colour consistency. PLA Pro is toughened — noticeably less brittle, which matters for functional parts that are still not hot.',
          'PLA Matte trades a little strength for a diffuse surface that hides layer lines remarkably well; it is the range to use for anything display-facing. PLA Silk is glossier still and prints best slightly hotter and slower — treat the finish as the point rather than the strength.',
          'Hyper PLA is formulated for high-speed printers. On a machine that can genuinely move, it keeps surface quality at flow rates where standard PLA starts to under-extrude. On a slower printer it behaves like good standard PLA and the premium is wasted.',
          'PLA Carbon Fibre is stiffer and matte, with a slightly abrasive filler — it needs a hardened nozzle. It does not make parts stronger in the way people expect; it makes them stiffer and less prone to creep.',
        ],
      },
      {
        heading: 'Getting a good result',
        body: [
          'Start at 210 °C on the nozzle and 60 °C on the bed and adjust from there. If layers separate, go up 5 °C; if you see stringing and blobs, come down 5 °C.',
          'Run cooling at 100% from the second layer. PLA is the one material where more cooling is almost always better, and overhangs improve dramatically with it.',
          'PLA rarely needs drying, but a spool left open in a damp workshop for months will start to pop and string. If in doubt, four hours at 45 °C fixes it.',
        ],
      },
    ],
  },
  {
    slug: 'petg',
    code: 'PETG',
    name: 'PETG',
    title: 'PETG filament — 1.75mm, 1kg spools',
    description:
      'PETG filament in 1.75mm, 1kg spools. Print settings, PLA vs PETG, and how to stop stringing. Vacuum-sealed, UK stock, same-day dispatch before 2pm.',
    standfirst:
      'The functional default. Tougher than PLA, more heat-tolerant, water-tight, and it bends before it breaks — at the cost of a fussier print.',
    settings: [
      { label: 'Nozzle', value: '230–250 °C' },
      { label: 'Bed', value: '70–80 °C' },
      { label: 'Cooling', value: '30–50%' },
      { label: 'Enclosure', value: 'Helpful, not required' },
      { label: 'Drying', value: 'Often worthwhile' },
    ],
    sections: [
      {
        heading: 'What PETG is for',
        body: [
          'PETG is the material for parts that have to do a job. Brackets, enclosures that live in a warm place, water-tight containers, clips that flex, and anything that will be dropped. It bends measurably before it fails, where PLA simply snaps.',
          'It holds up to roughly 75–80 °C, which covers a car interior in summer and the inside of most electronics enclosures. It is also food-safe as a polymer, although a 3D-printed surface is not food-safe regardless of material because the layer lines harbour bacteria.',
          'Layer adhesion is excellent, which is what makes it water-tight: a PETG print with sufficient walls will genuinely hold liquid where the same part in PLA weeps through the layer boundaries.',
        ],
      },
      {
        heading: 'What PETG is bad at',
        body: [
          'Fine detail. PETG oozes more than PLA and rounds off sharp corners. For miniatures and anything where crisp detail is the point, PLA gives a better result.',
          'Bridging and steep overhangs. Less cooling means less support from the air, so unsupported spans sag further than they would in PLA.',
          'Being printed straight out of the bag after a month on the shelf. PETG absorbs moisture faster than PLA and wet PETG strings badly, pops audibly, and prints with a rough matte surface. This is the single most common cause of "my PETG is stringy".',
          'Sticking too well. On a smooth PEI or glass bed, PETG can bond hard enough to pull chunks out of the surface. A thin layer of glue stick as a release agent is the standard fix — counter-intuitively, you use glue to make it stick less.',
        ],
      },
      {
        heading: 'Choosing between our PETG ranges',
        body: [
          'Standard PETG covers most work and is the range to start with. PETG Pro has tighter diameter consistency and a cleaner surface finish, which shows on large flat faces.',
          'Hyper PETG is tuned for high-speed machines in the same way Hyper PLA is — worth it on a printer that can actually use the flow rate, wasted on one that cannot.',
          'PETG Carbon Fibre is significantly stiffer and prints with a handsome matte finish, but it needs a hardened nozzle and it is more brittle than plain PETG. Reach for it when stiffness matters more than impact resistance.',
        ],
      },
      {
        heading: 'Getting a good result',
        body: [
          'Start at 240 °C and 75 °C bed. PETG is more sensitive to being too cold than too hot — under-extrusion and poor layer bonding usually mean go up, not down.',
          'Drop cooling to 30–50%. Full cooling is the classic PETG mistake: it looks like better overhangs and produces weak, delaminating parts.',
          'Dry the filament if it has been open more than a few weeks. Four to six hours at 65 °C. Most "bad PETG" is wet PETG.',
          'Slow retraction down and reduce its distance compared with PLA. PETG is stringier by nature and aggressive retraction grinds it in the extruder rather than fixing the strings.',
        ],
      },
    ],
  },
  {
    slug: 'abs',
    code: 'ABS',
    name: 'ABS',
    title: 'ABS filament — 1.75mm, 1kg spools',
    description:
      'ABS filament in 1.75mm, 1kg spools. Print settings, warping, enclosures and ventilation. Vacuum-sealed, UK stock, same-day dispatch before 2pm.',
    standfirst:
      'The engineering choice for heat and impact resistance. Demands an enclosure and ventilation, and rewards you with parts that survive things PLA cannot.',
    settings: [
      { label: 'Nozzle', value: '240–260 °C' },
      { label: 'Bed', value: '95–110 °C' },
      { label: 'Cooling', value: 'Off, or minimal' },
      { label: 'Enclosure', value: 'Required in practice' },
      { label: 'Drying', value: 'Worthwhile' },
    ],
    sections: [
      {
        heading: 'What ABS is for',
        body: [
          'ABS handles heat that would destroy PLA and softens around 100 °C, which puts it in a different category for anything mechanical, automotive or near a heat source. It is also genuinely tough: it absorbs impact by deforming rather than shattering.',
          'It machines and finishes well. ABS can be drilled and tapped without cracking, and it can be vapour-smoothed with acetone to a glossy, effectively water-tight surface — a finishing route no other material here offers.',
          'For functional prototypes that need to behave like injection-moulded parts, ABS is the closest match, because a great many injection-moulded parts are ABS.',
        ],
      },
      {
        heading: 'What ABS is bad at',
        body: [
          'Warping. This is the defining difficulty. ABS shrinks measurably as it cools, and on an open printer the corners of a large part lift off the bed and the print fails. An enclosure that keeps ambient temperature up is not optional for anything larger than a few centimetres.',
          'Ventilation. ABS emits styrene while printing, with a smell most people find unpleasant and which should not be breathed in a small unventilated room. Print it in a ventilated space or a filtered enclosure.',
          'Sunlight. ABS yellows and becomes brittle under UV. For outdoor parts use ASA, which is chemically similar and UV-stable.',
          'Fine surface detail on tall parts, where the lack of cooling shows.',
        ],
      },
      {
        heading: 'Choosing between our ABS ranges',
        body: [
          'Standard ABS is the general-purpose option. Hyper ABS is formulated for higher print speeds and is somewhat easier to get a clean result from, because its flow behaviour is more consistent.',
          'ABS Carbon Fibre is markedly stiffer and warps noticeably less than plain ABS — the fibres restrain the shrinkage — which makes it the easier ABS to print large parts in, at the cost of needing a hardened nozzle.',
        ],
      },
      {
        heading: 'Getting a good result',
        body: [
          'Enclose the printer and let it warm up before starting. Ambient temperature matters more than any slicer setting for ABS.',
          'Turn part cooling off, or run it under 20%. Cooling is what causes layers to contract at different rates and pull the part off the bed.',
          'Use a brim. Even a five-line brim dramatically improves the odds on a large footprint.',
          'Do not open the enclosure mid-print to look. The temperature drop is exactly what causes the delamination you were checking for.',
        ],
      },
    ],
  },
  {
    slug: 'asa',
    code: 'ASA',
    name: 'ASA',
    title: 'ASA filament — 1.75mm, 1kg spools',
    description:
      'ASA filament in 1.75mm, 1kg spools. UV-stable outdoor filament — print settings and how it compares with ABS. Vacuum-sealed, UK stock, same-day dispatch.',
    standfirst:
      'ABS that survives the weather. The right material for anything that lives outdoors, and the only one here that will not go chalky in sunlight.',
    settings: [
      { label: 'Nozzle', value: '240–260 °C' },
      { label: 'Bed', value: '95–110 °C' },
      { label: 'Cooling', value: 'Off, or minimal' },
      { label: 'Enclosure', value: 'Required in practice' },
      { label: 'Drying', value: 'Worthwhile' },
    ],
    sections: [
      {
        heading: 'What ASA is for',
        body: [
          'Outdoor parts. ASA was developed as a UV-stable replacement for ABS and it is the reason garden furniture, wing mirrors and signage survive years of sunlight without going chalky. If a printed part will spend its life outside, this is the material.',
          'It shares ABS’s mechanical properties almost exactly: similar heat resistance, similar toughness, similar ability to be drilled and tapped. Think of it as ABS with the weakness removed and a small price premium added.',
          'It also warps slightly less than ABS in practice, which makes it a little easier to print large parts in despite the near-identical settings.',
        ],
      },
      {
        heading: 'What ASA is bad at',
        body: [
          'Everything ABS is bad at, minus the UV problem. It still warps, still needs an enclosure, still wants ventilation, and still gives poorer fine detail than PLA.',
          'Price. ASA costs more than ABS, so using it for an indoor part is money spent on a property that part will never exercise.',
          'Printing in a cold room. More than any other material here, ASA punishes a draughty workshop. If parts are lifting, the answer is almost always ambient temperature rather than a slicer setting.',
        ],
      },
      {
        heading: 'ASA or ABS?',
        body: [
          'Outdoors, or exposed to strong sunlight through glass: ASA, without hesitation.',
          'Indoors, in a cupboard, inside a machine: ABS, and keep the difference.',
          'If you plan to acetone-smooth the part, both respond, though ABS is slightly more predictable.',
        ],
      },
      {
        heading: 'Getting a good result',
        body: [
          'Treat it exactly as ABS: enclosure, no part cooling, brim on large footprints, and no opening the door mid-print.',
          'Start at 250 °C nozzle and 100 °C bed and adjust in 5 °C steps.',
          'Dry it if it has been open a while. Wet ASA prints with a rough, bubbled surface that no temperature change will fix.',
        ],
      },
    ],
  },
  {
    slug: 'tpu',
    code: 'TPU',
    name: 'TPU',
    title: 'TPU filament — flexible, 1.75mm, 1kg spools',
    description:
      'Flexible TPU filament in 1.75mm, 1kg spools. Print settings for direct-drive and Bowden printers. Vacuum-sealed, UK stock, same-day dispatch before 2pm.',
    standfirst:
      'Rubber you can print. Gaskets, phone cases, grips, feet and anything that has to squash and come back — printed slowly, and ideally on a direct-drive extruder.',
    settings: [
      { label: 'Nozzle', value: '220–235 °C' },
      { label: 'Bed', value: '40–60 °C' },
      { label: 'Speed', value: '15–30 mm/s' },
      { label: 'Retraction', value: 'Minimal or none' },
      { label: 'Drying', value: 'Often essential' },
    ],
    sections: [
      {
        heading: 'What TPU is for',
        body: [
          'Anything that needs to flex and recover: gaskets and seals, phone and tool cases, vibration-damping feet, grips and handle covers, wheels and tyres for small robots, and protective corners.',
          'It is also extremely abrasion-resistant and tough — a TPU part will survive being crushed in a way no rigid material will, and it will not shatter when dropped.',
          'The 95A shore hardness we stock is the general-purpose choice: firm enough to print reliably, soft enough to be obviously flexible. TPU Pro has tighter diameter tolerance, which matters more than usual here because a flexible filament with a varying diameter is much more likely to buckle in the extruder.',
        ],
      },
      {
        heading: 'What TPU is bad at',
        body: [
          'Speed. TPU has to be printed slowly. Push it and the filament buckles between the drive gear and the nozzle rather than being pushed forward, and extrusion stops.',
          'Bowden printers. A long PTFE tube between the extruder and the hot end turns a flexible filament into a spring, which makes retraction and pressure control unpredictable. It is possible on a Bowden machine, but a direct-drive extruder makes it easy rather than a project.',
          'Retraction. Aggressive retraction settings that work in PLA will jam TPU. Reduce distance sharply or disable it and accept a little stringing.',
          'Dimensional precision. A flexible part deforms under its own weight and under the caliper, so hitting a tolerance is a different discipline from rigid materials.',
          'Moisture. TPU absorbs water quickly and wet TPU prints with a bubbled, weak, hairy surface. Of everything here, this is the material most likely to need drying before use.',
        ],
      },
      {
        heading: 'Getting a good result',
        body: [
          'Slow down before changing anything else. 20 mm/s solves most TPU problems on its own.',
          'Print directly from a dry spool where you can, and dry for four to six hours at 50 °C if the filament has been open.',
          'Reduce or disable retraction and increase minimum travel distance so the printer retracts less often.',
          'Keep the filament path as short and as constrained as possible — the fewer places it can buckle, the more reliable the print.',
        ],
      },
    ],
  },
];

export function findMaterial(slug: string): MaterialDefinition | undefined {
  return MATERIALS.find((m) => m.slug === slug.toLowerCase());
}

/**
 * Does this group belong to this material?
 *
 * Word-boundary match on the group name, because the storefront API has
 * no material field. Anchored so "PLA" cannot match inside another
 * token, and so ABS and ASA — one letter apart — never match each other.
 */
export function groupMatchesMaterial(groupName: string, code: string): boolean {
  return new RegExp(`\\b${code}\\b`, 'i').test(groupName);
}
