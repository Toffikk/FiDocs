# AGENTS.md

Documentation site for [Fidorial](https://github.com/Fidorial/Fidorial), a Minecraft server written
from scratch in Java. The docs teach plugin authors how to use the plugin API (`fidorial-api`).
Built with Astro Starlight. English is the root locale, French lives under `fr/`.

## Layout

```
src/content/docs/
├── index.mdx                       # splash page
├── getting-started/first-plugin.mdx
├── guides/
│   ├── commands.mdx
│   ├── events.mdx
│   ├── services.mdx
│   └── threads.mdx
├── reference/fidorial-json.mdx
└── fr/                             # same tree, same file names, in French
scripts/api-diff.mjs                # API diff generator (see below)
```

Every page exists in both languages with **the same path**. Links in French pages are prefixed with
`/fr/` (`/fr/guides/threads/`); English links are not (`/guides/threads/`).

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

The site is built with Starlight, which has its own docs for components, sidebar and i18n:
https://starlight.astro.build

## Updating the docs for a new API version

The API changes often. The source of truth is always the code, never these pages or your memory
of an older version.

1. **Generate the diff** between the branch the docs currently follow and the new one:

   ```sh
   npm run api-diff -- dev/26.3 dev/26.4
   ```

   It clones the Fidorial repo (bare, blobless) into `.cache/fidorial.git` and writes
   `api-diff/<from>..<to>/`:

   | File | Use |
      | --- | --- |
   | `SUMMARY.md` | Commits touching the API (with PR numbers), and changed files grouped by added / removed / renamed / modified. Read first. |
   | `surface.diff` | Public declarations only: types, fields, method signatures. No bodies, Javadoc or private members. The quickest way to see what changed for plugin authors. |
   | `full.diff` | The full diff, Javadoc included. Read it for intent and behaviour changes that do not show in signatures. |
   | `files.tsv` | Raw `git diff --name-status`. |

   The docs follow the branch named in the caution box of `index.mdx`. Use it as `<from>`.

2. **Find what the pages use.** Grep every page (both languages) for each removed or renamed
   type and method listed in `SUMMARY.md` and `surface.diff`. Also look for code samples that call
   methods whose signature changed.

3. **Check against the real source.** Before writing a call in a sample, read the file at the
   target ref:

   ```sh
   git --git-dir .cache/fidorial.git show dev/26.4:fidorial-api/src/main/java/fr/fidorial/Server.java
   git --git-dir .cache/fidorial.git grep -n "interface PlayerManager" dev/26.4 -- fidorial-api
   ```

   Never invent a method because it "should" exist. If the docs need something the API does not
   have, say so in your report instead of writing it.

4. **Look beyond signatures.** `full.diff` and the commit messages also carry behaviour changes
   that matter to the guides: start order (what runs before `onEnable`), threading, what is cleaned
   up automatically, things that became automatic (e.g. command tree resends). Server-side changes
   can matter too: diff `fidorial-server` with `--path fidorial-server` when a guide describes server
   behaviour.

5. **Update English and French together**, in the same change. Then update the version note in
   `index.mdx` (both languages) and the dependency version in `first-plugin.mdx`.

6. **Check the pages render.** Start the dev server in background mode (see Development), open
   every page you touched in both languages, and check `astro dev logs` for MDX or link errors.
   Stop the server when you are done.

7. **Report** what you changed per page, and list anything you could not verify or that looks
   like an API bug or inconsistency rather than silently working around it.

## Writing style

- Second person, short sentences, present tense. French uses **tu**.
- Lead with the code, then explain. Tables for reference material (methods, fields, threads).
- No marketing words, no "simply", "just", "easily".
- Use Starlight components already imported in the pages: `Aside` (`tip`, `caution`), `Tabs`,
  `TabItem`, `Steps`, `Card`, `CardGrid`, `LinkCard`.
- Keep the two languages structurally identical: same headings, same tables, same samples. Only
  the prose, identifiers chosen for the example (`announce` / `annonce`) and comments change.

### French terminology

Keep the vocabulary consistent with the existing pages: événement, abonnement, écouteur (listener),
région, thread, thread virtuel, plugin, commande, joueur, monde, bloc, chunk, service, registre,
implémentation, priorité, propriétaire (service owner). Code identifiers stay in English.

## Code samples

Samples must compile against the target API version and follow the project's style:

- `final` everywhere: locals, parameters, fields, pattern variables (`instanceof final Player player`).
- Modern Java (25): records, pattern matching, pattern-matching `switch`.
- Adventure types for text (`Component`, `NamedTextColor`…).
- Respect threading: anything that changes an entity or the world from a command or an async
  callback goes through `execute(...)` on the right `SchedulerSource`. See `guides/threads.mdx`.
- Brigadier primitives come from Brigadier itself (`StringArgumentType`, `IntegerArgumentType`…);
  Minecraft argument types come from `Arguments.arguments()`.

## Do not

- Do not edit `.cache/` or `api-diff/`. They are generated and git-ignored.
- Do not document internal classes (`fr.euphyllia.fidorial.server.*`) or package-private API
  implementations (`*Impl`). Plugin authors only see `fr.fidorial.*` public types.
- Do not change the meaning of a page while translating it. If the English is wrong, fix both.
