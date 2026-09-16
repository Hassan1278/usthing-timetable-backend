# Contributing

Small PRs, rebase-clean on `main`. That's most of it. Branch off, make your change, run the checks at the bottom, open a PR. Reviews are questions and suggestions rather than verdicts on you; expect a couple of rounds on anything nontrivial, and batch your follow-ups so a review can actually converge.

## Style

Formatting is Biome's job, so don't think about it. What we do care about is the shape of the code. We lean functional here: immutable objects where you can, `.map` and friends over loops, as few side effects as possible. Not dogma, just less state to hold in your head while reading.

Never write this:

```typescript
const numbers = [1, 2, 3];
const squares = [];
for (const n of numbers) {
  squares.push(n * n);
}
```

`squares` gets mutated inside a loop with a side effect, and the loop only exists because nobody reached for `.map`. Write this instead:

```typescript
const numbers = [1, 2, 3];
const squares = numbers.map((n) => n * n);
```

If the second version looks unfamiliar, [MDN's list of iterative methods](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array#iterative_methods) is worth ten minutes.

## Formatting and lint

Biome handles formatting, linting, and import order; you shouldn't need any other tool. `bun run fmt` formats, `bun run lint` auto-fixes, and `bun run check` is the read-only version of both. Imports sort themselves when you run `bunx biome check --write .`.

## Before you open a PR

```sh
bun run compile && bun run check && bun test
```

All three need to pass. If they don't, the review starts there instead of on your actual change.
