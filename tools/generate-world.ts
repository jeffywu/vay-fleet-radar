import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORLD_SEED, generateWorld, roundedWorld, validateWorld, type WorldData } from "../packages/world/src/index.ts";

type Options = { seed: string; force: boolean; outputDirectory: string };

export function parseArguments(arguments_: readonly string[]): Options {
  let seed = DEFAULT_WORLD_SEED;
  let force = false;
  let outputDirectory = resolve(process.cwd(), "assets/world");

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--force") force = true;
    else if (argument === "--seed") {
      seed = arguments_[index + 1] ?? "";
      index += 1;
      if (!seed) throw new Error("--seed requires a non-empty value");
    } else if (argument === "--output") {
      const value = arguments_[index + 1];
      index += 1;
      if (!value) throw new Error("--output requires a directory");
      outputDirectory = resolve(value);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { seed, force, outputDirectory };
}

export function serializeWorld(world: WorldData): Record<string, string> {
  const rounded = roundedWorld(world);
  validateWorld(rounded);
  return {
    "service-area.geojson": `${JSON.stringify(rounded.serviceArea, null, 2)}\n`,
    "service-zones.geojson": `${JSON.stringify(rounded.serviceZones, null, 2)}\n`,
    "destinations.json": `${JSON.stringify(rounded.destinations, null, 2)}\n`,
  };
}

export async function writeWorldAssets(options: Options): Promise<void> {
  const files = serializeWorld(generateWorld(options.seed));
  await mkdir(options.outputDirectory, { recursive: true });
  if (!options.force) {
    for (const name of Object.keys(files)) {
      const path = resolve(options.outputDirectory, name);
      try {
        await access(path, constants.F_OK);
        throw new Error(`${path} already exists; pass --force to replace generated assets`);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
  }
  await Promise.all(Object.entries(files).map(([name, contents]) => writeFile(resolve(options.outputDirectory, name), contents, "utf8")));
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  await writeWorldAssets(options);
  console.log(`Generated 200 Las Vegas destinations with seed "${options.seed}" in ${options.outputDirectory}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
