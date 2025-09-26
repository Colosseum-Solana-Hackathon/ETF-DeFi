const swaggerSpec = {
  openapi: "3.0.3",
  info: {
    title: "ETF-DeFi Backend API",
    version: "1.0.0",
    description: "API documentation for ETF-DeFi backend",
  },
  servers: [
    {
      url: "http://localhost:3000",
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
  },
  components: {},
} as const;

export default swaggerSpec;


