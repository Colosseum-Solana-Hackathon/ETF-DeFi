use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    /// Input structure matching vault's encrypted portfolio data
    /// This receives 13 encrypted values representing the portfolio state
    pub struct RebalancingInput {
        // Asset balances (3 assets)
        pub btc_balance: u64,
        pub eth_balance: u64,
        pub sol_balance: u64,
        
        // Asset prices (3 assets)
        pub btc_price: u64,
        pub eth_price: u64,
        pub sol_price: u64,
        
        // Target weights (3 assets, as percentages)
        pub btc_weight: u8,
        pub eth_weight: u8,
        pub sol_weight: u8,
        
        // Current weights (3 assets, as percentages)
        pub btc_current: u8,
        pub eth_current: u8,
        pub sol_current: u8,
        
        // Rebalancing threshold (percentage drift tolerance)
        pub threshold: u8,
    }

    /// Output structure with rebalancing decision
    /// Kept simple to avoid MPC compiler limitations
    pub struct RebalancingResult {
        pub needs_rebalance: bool,
        pub btc_drift: i16,      // Drift in percentage points
        pub eth_drift: i16,
        pub sol_drift: i16,
        pub total_tvl: u64,      // Total value locked in micro-dollars
    }

    /// Compute whether rebalancing is needed based on portfolio drift
    /// 
    /// This function analyzes encrypted portfolio data to determine if
    /// rebalancing is required, without revealing actual balances or prices.
    /// Only the rebalancing decision and drifts are returned.
    #[instruction]
    pub fn compute_rebalancing(
        input_ctxt: Enc<Shared, RebalancingInput>,
    ) -> Enc<Shared, RebalancingResult> {
        let input = input_ctxt.to_arcis();

        // Calculate total portfolio value (in micro-dollars with 6 decimals)
        // Simplified: assuming prices are already in micro-dollars
        let btc_value = input.btc_balance * input.btc_price / 1_000_000;
        let eth_value = input.eth_balance * input.eth_price / 1_000_000;
        let sol_value = input.sol_balance * input.sol_price / 1_000_000;
        
        let total_tvl = btc_value + eth_value + sol_value;

        // Calculate drifts (current weight - target weight)
        let btc_drift = input.btc_current as i16 - input.btc_weight as i16;
        let eth_drift = input.eth_current as i16 - input.eth_weight as i16;
        let sol_drift = input.sol_current as i16 - input.sol_weight as i16;

        // Check if any asset exceeds threshold
        let btc_exceeds = btc_drift.abs() > input.threshold as i16;
        let eth_exceeds = eth_drift.abs() > input.threshold as i16;
        let sol_exceeds = sol_drift.abs() > input.threshold as i16;
        
        let needs_rebalance = btc_exceeds || eth_exceeds || sol_exceeds;

        let result = RebalancingResult {
            needs_rebalance,
            btc_drift,
            eth_drift,
            sol_drift,
            total_tvl,
        };

        input_ctxt.owner.from_arcis(result)
    }
}
