// Manual-testing helper (not part of the library): connects one SyncClient
// to a doc, lets you type lines that get appended live, and prints the
// current merged content whenever anyone (including you) changes it. Run two
// of these against the same docName in separate terminals to watch real CRDT
// convergence, and set presence so the CLI dashboard has something to show.
//
// Usage: npm run demo -- <docName> [agentId] [serverUrl]
import readline from "node:readline";
import { SyncClient } from "../src/client/SyncClient.js";

const [, , docName = "demo.txt", agentId = `agent-${Math.random().toString(36).slice(2, 6)}`, serverUrl = process.env.AGENT_SYNC_SERVER ?? "ws://localhost:4600"] =
  process.argv;

const client = new SyncClient({ serverUrl, docName });
await client.connect();
await client.whenSynced();
client.setPresence({ agentId, status: "editing" });

function printContent(): void {
  console.log(`\n--- ${docName} (as seen by ${agentId}) ---\n${client.getText().toString()}\n---`);
}

client.getText().observe(() => printContent());
printContent();

console.log(`Connected as "${agentId}" to ${serverUrl}/${docName}. Type a line + Enter to append it. Ctrl+C to quit.`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const ytext = client.getText();
  ytext.insert(ytext.length, line + "\n");
});

process.on("SIGINT", () => {
  client.close();
  process.exit(0);
});
