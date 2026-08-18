/**
 * The audio-formatting prompt shown on the read page. The user copies it into
 * any LLM alongside an article and gets back text that survives text-to-speech:
 * math and symbols are said in words instead of being dropped, and nothing is
 * stripped downstream. This app never consumes it — it is purely a copy
 * utility for the user's own workflow.
 */
export const AUDIO_PROMPT = `You are converting an article into text that will be consumed downstream by a text-to-speech (TTS) model. Your output is read aloud, never displayed — write for the ear, not the eye. Transform the article so that every part of it survives as natural, spoken English.

The one hard rule: keep everything. Never delete, drop, skip, or summarize content. When something cannot be read as written — math, formulas, tables, symbols — convert it into spoken words instead of removing it. Every paragraph, bullet and equation in the source must have a counterpart in your output.

Math — spread it out for the ear. Never output math notation; always say it in words:

- Exponents: n² → "n squared"; n³ → "n cubed"; n⁵ → "n to the fifth"; 2ⁿ → "two to the n"; n^k → "n to the k".
- Greek letters: Θ → "big theta"; θ → "theta"; Ω → "big omega"; ω → "omega"; Σ → "sigma"; λ → "lambda"; α → "alpha"; β → "beta"; π → "pi"; Δ → "delta"; ε → "epsilon".
- Symbols: ≤ → "less than or equal to"; ≥ → "greater than or equal to"; ≈ → "approximately"; ≠ → "not equal to"; × → "times"; → → "to" (or "approaches" for limits); ∞ → "infinity"; √ → "the square root of"; ∑ → "the sum of"; ∀ → "for all"; ∃ → "there exists"; ∈ → "in"; ∝ → "is proportional to"; ⇒ → "implies"; ± → "plus or minus"; · → "times"; ~ → "approximately".
- Fractions and products: n(n−1)/2 → "n times n minus one, all over two"; a/b → "a over b"; 1 → 2 → 4 → … → 2^k → "one, two, four, and so on, up to two to the k".
- Subscripts: n₀ → "n sub zero"; T₁ → "T sub one".
- Function notation: f(n) → "f of n"; T(n) = aT(n/b) + f(n) → "T of n equals a times T of n over b, plus f of n"; O(g(n)) → "big O of g of n".
- Bounds get their plain names where natural: O(1) "constant time"; O(n) "linear"; O(n log n) "n log n"; O(n²) "quadratic"; O(log n) "logarithmic". For example Θ(n²) → "big theta of n squared — quadratic".
- Display equations ($$…$$, \\[…\\]) are never skipped: after the surrounding sentence, state the equation as its own spoken sentence. For example: "Formally, f of n is big O of g of n if there exists a positive constant c and a threshold n sub zero such that f of n is less than or equal to c times g of n, for all n greater than or equal to n sub zero."

Formatting — plain prose only. The TTS model reads exactly what you output, so leave nothing behind for it to choke on:

- Output plain text: no markdown, no asterisks, no underscores, no backticks, no $ or LaTeX. Emphasis becomes words: "the key point is", "crucially", "in contrast".
- Headings stay, as their own short sentence marking the next section: "The Mathematical Machinery and the Discards."
- Bullet lists become flowing sentences ("First, … Second, …") or short spoken points. Never say "bullet" or "list item"; never drop an item.
- Tables become sentences; every cell's content is represented.
- Links keep only their visible text; URLs are dropped. Images: speak a meaningful alt text, otherwise drop.
- Code terms stay as words — break, append, hash table — they read fine. Unpronounceable tokens get described, never skipped.
- Abbreviations expand: e.g. → "for example"; i.e. → "that is"; etc. → "et cetera"; vs. → "versus". Acronyms stay as spoken (CPU, TTS, I/O).
- Parenthetical asides are integrated into the sentence — never read "open paren".
- Long sentences split in two; paragraphs stay separated by blank lines so pauses land naturally.

Output only the transformed article — no preamble, no explanation, no closing note.`;
