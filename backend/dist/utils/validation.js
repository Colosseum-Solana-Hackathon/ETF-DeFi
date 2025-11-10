"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidSolanaAddress = isValidSolanaAddress;
exports.isValidISOTimestamp = isValidISOTimestamp;
/**
 * Validates a Solana public key format
 * Solana public keys are base58 encoded and typically 32-44 characters long
 * @param address - The wallet address to validate
 * @returns true if valid, false otherwise
 */
function isValidSolanaAddress(address) {
    if (!address || typeof address !== "string") {
        return false;
    }
    // Solana public keys are base58 encoded, 32-44 characters
    // Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
    // Excludes: 0, O, I, l
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(address);
}
/**
 * Validates an ISO 8601 timestamp string
 * @param timestamp - The timestamp string to validate
 * @returns true if valid, false otherwise
 */
function isValidISOTimestamp(timestamp) {
    if (!timestamp || typeof timestamp !== "string") {
        return false;
    }
    try {
        const date = new Date(timestamp);
        // Check if the date is valid and the string is a valid ISO format
        if (isNaN(date.getTime())) {
            return false;
        }
        // Accept ISO 8601 format (with or without milliseconds, with or without timezone)
        // Examples: "2024-01-01T00:00:00Z", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00+00:00"
        const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
        return isoRegex.test(timestamp);
    }
    catch {
        return false;
    }
}
