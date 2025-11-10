const swaggerSpec = {
  openapi: "3.0.3",
  info: {
    title: "ETF-DeFi Backend API",
    version: "1.0.0",
    description: "API documentation for ETF-DeFi backend",
  },
  servers: [
    {
      url: "http://localhost:8000",
      description: "Localized server",
    },
  ],
  paths: {
    "/api/jupiter/order": {
      get: {
        summary: "Get Jupiter order route",
        description:
          "Returns a route for swapping from inputMint to outputMint using Jupiter",
        tags: ["Jupiter"],
        parameters: [
          {
            name: "inputMint",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Input mint address",
          },
          {
            name: "outputMint",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Output mint address",
          },
          {
            name: "amount",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "Amount in minor units (e.g., lamports)",
          },
          {
            name: "taker",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "slippageBps",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "referralAccount",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "referralFee",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "Successful response",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          400: { description: "Missing required parameters" },
          500: { description: "Internal server error" },
        },
      },
    },
    "/api/jupiter/execute": {
      post: {
        summary: "Execute a signed transaction via Jupiter",
        tags: ["Jupiter"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["signedTransaction", "requestId"],
                properties: {
                  signedTransaction: {
                    type: "string",
                    description: "Base64 encoded signed transaction",
                  },
                  requestId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Successful execution response",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          400: { description: "Missing required fields" },
          500: { description: "Internal server error" },
        },
      },
    },
    "/api/jupiter/tokens": {
  get: {
    summary: "Get paginated list of Jupiter tokens",
    tags: ["Jupiter"],
    parameters: [
      {
        name: "page",
        in: "query",
        required: false,
        schema: { type: "integer", default: 1 },
        description: "Page number",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", default: 20 },
        description: "Number of tokens per page",
      },
    ],
    responses: {
      200: {
        description: "Paginated list of tokens",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                page: { type: "integer" },
                limit: { type: "integer" },
                total: { type: "integer" },
                tokens: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      symbol: { type: "string" },
                      name: { type: "string" },
                      address: { type: "string" },
                      icon: { type: "string", nullable: true },
                      network: { type: "string" },
                      archived: { type: "boolean" },
                      badge: { type: "string", nullable: true },
                      decimals: { type: "integer" },
                      priceUsd: { type: "number", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      500: { description: "Internal server error" },
    },
  },
    },
    "/api/wallet/connect": {
      post: {
        summary: "Track wallet connection",
        description:
          "Saves wallet connection data to Supabase for analytics and tracking purposes",
        tags: ["Wallet"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["walletAddress", "walletProvider", "connectedAt"],
                properties: {
                  walletAddress: {
                    type: "string",
                    description: "Solana public key (base58 encoded, 32-44 characters)",
                    example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
                  },
                  walletProvider: {
                    type: "string",
                    description: "Wallet provider name (e.g., 'Phantom', 'Solflare', 'Backpack')",
                    example: "Phantom",
                  },
                  connectedAt: {
                    type: "string",
                    format: "date-time",
                    description: "ISO 8601 timestamp of when the wallet was connected",
                    example: "2024-01-15T10:30:00.000Z",
                  },
                  network: {
                    type: "string",
                    enum: ["devnet", "mainnet-beta"],
                    description: "Solana network the wallet is connected to",
                    example: "mainnet-beta",
                  },
                  userAgent: {
                    type: "string",
                    description: "Browser user agent string",
                    example: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  },
                  sessionId: {
                    type: "string",
                    description: "Session identifier for tracking user sessions",
                    example: "sess_abc123xyz",
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Wallet connection tracked successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: {
                      type: "boolean",
                      example: true,
                    },
                    message: {
                      type: "string",
                      example: "Wallet connection tracked successfully",
                    },
                    walletId: {
                      type: "string",
                      format: "uuid",
                      description: "UUID of the created wallet connection record",
                      example: "123e4567-e89b-12d3-a456-426614174000",
                    },
                  },
                },
              },
            },
          },
          400: {
            description: "Validation error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: {
                      type: "boolean",
                      example: false,
                    },
                    message: {
                      type: "string",
                      example: "Invalid Solana wallet address format. Must be a valid base58-encoded public key (32-44 characters)",
                    },
                  },
                },
              },
            },
          },
          500: {
            description: "Internal server error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: {
                      type: "boolean",
                      example: false,
                    },
                    message: {
                      type: "string",
                      example: "Failed to save wallet connection data",
                    },
                    error: {
                      type: "string",
                      description: "Error details (only in development)",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {},
} as const;

export default swaggerSpec;


