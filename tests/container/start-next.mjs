import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const arguments_ = process.argv.slice(2);

function option(name, fallback) {
  const index = arguments_.indexOf(name);
  if (index === -1) return fallback;
  const value = arguments_[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

process.env.HOSTNAME = option("--hostname", "0.0.0.0");
process.env.PORT = option("--port", "3000");

await import(pathToFileURL(path.join(directory, "server.js")).href);
