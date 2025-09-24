/**
 * Script to convert a Solana keypair JSON array to a base58-encoded string.
 *
 * Usage:
 *   - Place your keypair JSON file (e.g., devnet-keypair.json) in the same directory.
 *   - Run this script to print the base58-encoded private key to the console.
 */
import fs from "fs";
import bs58 from "bs58";

// Reads the keypair array from the JSON file.
const arr = JSON.parse(fs.readFileSync("./devnet-keypair.json", "utf8"));
console.log(bs58.encode(Buffer.from(arr)));
