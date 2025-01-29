import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { execSync } from "node:child_process";
import { build } from "esbuild";
import toml from "@iarna/toml";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

/** @type {import('./index.js').default} */
export default function (opts = {}) {
  const { out = "bin", silent = false, entry = "" } = opts;
  return {
    name: "sveltekit-adapter-fastly",
    async adapt(builder) {
      //validate fastly config
      await validate_config(builder, silent);

      //Removing tmp directory if exists
      const files = fileURLToPath(new URL("./files", import.meta.url).href);
      const tmp = builder.getBuildDirectory("fastly-tmp");
      builder.rimraf(tmp);
      builder.rimraf(out);
      builder.mkdirp(tmp);
      builder.log.minor("Copying Static assets...");
      //copy static assests to tmp directory
      const static_dir = `${tmp}/static`;
      builder.writeClient(static_dir);
      builder.writePrerendered(static_dir);

      if (opts.staticPublishConfig) {
        await validate_static_publish_config(builder, opts.staticPublishConfig);
        builder.copy(
          opts.staticPublishConfig,
          `${tmp}/static-publish.rc.js`,
          {}
        );
      } else {
        //sticking with default
        builder.copy(
          `${files}/static-publish.rc.js`,
          `${tmp}/static-publish.rc.js`,
          {}
        );
      }

      execSync(`npx @fastly/compute-js-static-publish --build-static`, {
        cwd: `${tmp}`,
        stdio: "inherit",
      });

      const workerSource = `${tmp}/src`;
      const relativePath = posix.relative(tmp, builder.getServerDirectory());

      let prerendered_entries = Array.from(builder.prerendered.pages.entries());

      if (builder.config.kit.paths.base) {
        prerendered_entries = prerendered_entries.map(([path, { file }]) => [
          path,
          { file: `${builder.config.kit.paths.base}/${file}` },
        ]);
      }
      await build({
        conditions: ["fastly"],
        entryPoints: [entry ? entry : `${files}/entry.js`],
        bundle: true,
        outdir: workerSource,
        write: true,
        external: ["fastly:*"],
        allowOverwrite: true,
        format: "esm",
        tsconfig: undefined,
        plugins: [
          {
            name: "svelte-adapter-fastly",
            setup(build) {
              build.onResolve({ filter: /^svelte-adapter-fastly/ }, () => {
                return { path: `${files}/handleSvelteKitRequest.js` };
              });
              build.onResolve({ filter: /^MANIFEST/ }, (args) => ({
                path: args.path,
                namespace: "svelte-adapter-fastly",
              }));

              build.onResolve({ filter: /^STATICS/ }, () => {
                return { path: `${tmp}/static-publisher/statics.js` };
              });
              build.onResolve({ filter: /^SERVER/ }, () => {
                return { path: `${builder.getServerDirectory()}/index.js` };
              });
              build.onLoad(
                { filter: /.*/, namespace: "svelte-adapter-fastly" },
                async () => {
                  return {
                    loader: "js",
                    resolveDir: tmp,
                    contents:
                      `export const manifest = ${builder.generateManifest({
                        relativePath,
                      })};\n\n` +
                      `export const prerendered = new Map(${JSON.stringify(
                        prerendered_entries
                      )});\n\n` +
                      `export const base_path = ${JSON.stringify(
                        builder.config.kit.paths.base
                      )};\n`,
                  };
                }
              );
            },
          },
        ],
      });

      builder.log("Building worker...");

      console.log("creating wasm file");
      execSync(
        `npx --package @fastly/js-compute  js-compute-runtime ${
          opts.experimentalTopLevelAwait
            ? `--enable-experimental-top-level-await`
            : ""
        }  ${workerSource}/entry.js ./bin/main.wasm`,
        {
          cwd: `${tmp}`,
          stdio: "inherit",
        }
      );
      builder.copy(`${tmp}/bin/main.wasm`, `${out}/main.wasm`, {});
      builder.log(
        "Fastly Worker built successfully run fastly compute serve to test locally"
      );
    },
    async emulate() {
      /** @type {import('fastly:geolocation').Geolocation} */
      const emuGeo = {
        area_code: 54304,
        city: "Green Bay",
        country_code: "US",
        country_code3: "USA",
        country_name: "United States",
        conn_speed: "Cable/DSL",
        conn_type: "Corporate",
        as_name: "Unknown",
        as_number: 1,
        latitude: 44.519,
        longitude: -88.0198,
        postal_code: "54304",
        region: "WI",
        continent: "NA",
        utc_offset: -6,
        proxy_description: "Corporate",
        proxy_type: "Corporate",
        metro_code: 658,
        gmt_offset: "Test",
      };
      return {
        platform: () => {
          return {
            env: () => "local",
            geo: emuGeo,
          };
        },
      };
    },
  };
}

/**
 * @param {import('@sveltejs/kit').Builder} builder
 * @param {string} file
 */
async function validate_static_publish_config(builder, file) {
  if (!existsSync(file)) {
    builder.log(
      "No static-publish.rc.js file found. Using default configuration."
    );
    return;
  }

  const path = resolve(file);
  const publishConfig = await import(path).then((m) => m.default);

  if (publishConfig.rootDir !== "./static") {
    builder.log.warn(
      "RootDir is not ./static. This may cause issues with the adapter"
    );
  }

  return true;
}

/**
 * @param {import('@sveltejs/kit').Builder} builder
 * @param {boolean} silent
 * @returns {Promise<import('./index.js').FastlyConfig>}
 */
async function validate_config(builder, silent) {
  if (existsSync("fastly.toml")) {
    /** @type {import('./index.js').FastlyConfig} */
    let fastly_config;

    try {
      fastly_config = /** @type {import('./index.js').FastlyConfig} */ (
        toml.parse(readFileSync("fastly.toml", "utf-8"))
      );
    } catch (err) {
      err.message = `Error parsing fastly.toml: ${err.message}`;
      throw err;
    }

    if (fastly_config.language !== "javascript") {
      throw new Error(
        'You must specify `language = "javascript"` in fastly.toml.'
      );
    }

    return fastly_config;
  }

  if (silent) {
    throw new Error("Missing a fastly.toml file");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const res = await rl.question("No fastly.toml file. Create one? (y/n): ");

  if (res.toLowerCase() === "y") {
    const name = await rl.question("Please enter name of project: ");
    const service_id = await rl.question(
      "Please enter service id of compute service: "
    );
    const author = await rl.question("Please enter author name: ");
    rl.close();
    writeFileSync(
      "fastly.toml",
      `manifest_version = 3
service_id = "${service_id}"
name = "${name}"
description = "A SvelteKit project deployed on Fastly Compute@Edge"
authors = ["${author}"]
language = "javascript"

[scripts]
build = "npm run build"`,
      {
        encoding: "utf-8",
      }
    );

    return {
      manifest_version: 3,
      name,
      language: "javascript",
    };
  }

  builder.log(
    `
		Sample fastly.toml:
		
    manifest_version = 3
    service_id = "<your-service-id>"
    name = "<your-site-name>"
    description = "A SvelteKit project deployed on Fastly Compute@Edge"
		authors = ["<your-name>"]
    language = "javascript"`
      .replace(/^\t+/gm, "")
      .trim()
  );
  throw new Error(
    "Missing a fastly.toml file. please create one and try again"
  );
}
