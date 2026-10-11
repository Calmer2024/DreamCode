import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const context = path.join(root, "packages/evals/container/agents");
const lockDigest = createHash("sha256")
  .update(await readFile(path.join(context, "package-lock.json")))
  .update(await readFile(path.join(context, "sdk/package-lock.json")))
  .digest("hex");
const tag = process.argv[2] ?? "dreameval-external-agents:2026-10-10";
const image = JSON.parse(
  (await exec("docker", ["image", "inspect", tag], { maxBuffer: 1000000 })).stdout,
)[0].Id;
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error("Invalid installation image");
const actualDigest = (
  await exec(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      image,
      "node",
      "-e",
      'const fs=require("fs"),crypto=require("crypto");console.log(crypto.createHash("sha256").update(fs.readFileSync("/opt/harness/package-lock.json")).update(fs.readFileSync("/opt/harness/sdk/package-lock.json")).digest("hex"));',
    ],
    { timeout: 20000 },
  )
).stdout.trim();
if (actualDigest !== lockDigest)
  throw Error("Installation image does not match the checked-in locks; rebuild it first");
const volume = `dreameval-harness-${image.slice(7, 31)}`;
const exists = await exec("docker", ["volume", "inspect", volume])
  .then(() => true)
  .catch(() => false);
if (!exists) {
  await exec("docker", [
    "volume",
    "create",
    "--label",
    `dreameval.image=${image}`,
    "--label",
    `dreameval.lock=${lockDigest}`,
    volume,
  ]);
  console.log(`Preparing immutable Agent volume: ${volume}`);
  await exec(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "--user=0:0",
      "--mount",
      `type=volume,src=${volume},dst=/export`,
      image,
      "cp",
      "-a",
      "/opt/harness/.",
      "/export/",
    ],
    { timeout: 300000, maxBuffer: 1000000 },
  );
}
const inspection = JSON.parse((await exec("docker", ["volume", "inspect", volume])).stdout)[0];
if (
  inspection.Labels?.["dreameval.image"] !== image ||
  inspection.Labels?.["dreameval.lock"] !== lockDigest
)
  throw Error("Existing volume belongs to a different lock/image");
const manifest = JSON.parse(await readFile(path.join(context, "package.json"), "utf8"));
const agents = {
  "claude-code": {
    version: manifest.dependencies["@anthropic-ai/claude-code"],
    command: ["/opt/harness/node_modules/.bin/claude"],
  },
  pi: {
    version: manifest.dependencies["@earendil-works/pi-coding-agent"],
    command: [
      "node",
      "/opt/harness/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    ],
  },
  opencode: {
    version: manifest.dependencies["opencode-ai"],
    command: ["/opt/harness/node_modules/.bin/opencode"],
  },
  dsh: { version: manifest.dependencies["@deepseek-ai/dsh"], command: ["node"] },
};
await exec(
  "docker",
  [
    "run",
    "--rm",
    "--network=none",
    "--mount",
    `type=volume,src=${volume},dst=/opt/harness,readonly,volume-nocopy`,
    image,
    "node",
    "-e",
    'const fs=require("node:fs");for(const name of ["@anthropic-ai/claude-code","@earendil-works/pi-coding-agent","opencode-ai","@deepseek-ai/dsh"])fs.accessSync("/opt/harness/node_modules/"+name+"/package.json");fs.accessSync("/opt/harness/sdk/node_modules/@deepseek-ai/dsh-sdk-client/package.json");',
  ],
  { timeout: 20000 },
);
const destination = path.join(root, "evals/agents/installation.json");
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(
  `${destination}.tmp`,
  JSON.stringify({ version: 1, image, volume, lockDigest, agents }, null, 2),
);
await rename(`${destination}.tmp`, destination);
console.log(JSON.stringify({ destination, image, volume, lockDigest, agents }));
