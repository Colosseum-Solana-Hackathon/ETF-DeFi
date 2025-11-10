-- Migration: Create wallet_connections table
-- Description: Stores wallet connection data from frontend
-- Created: 2024

CREATE TABLE IF NOT EXISTS wallet_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address TEXT NOT NULL,
  wallet_provider TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL,
  network TEXT,
  user_agent TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_wallet_address ON wallet_connections(wallet_address);
CREATE INDEX IF NOT EXISTS idx_connected_at ON wallet_connections(connected_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_provider ON wallet_connections(wallet_provider);
CREATE INDEX IF NOT EXISTS idx_session_id ON wallet_connections(session_id) WHERE session_id IS NOT NULL;

-- Create updated_at trigger function (if it doesn't exist)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_wallet_connections_updated_at ON wallet_connections;
CREATE TRIGGER update_wallet_connections_updated_at
    BEFORE UPDATE ON wallet_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

