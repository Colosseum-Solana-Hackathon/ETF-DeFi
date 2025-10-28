use arcis_imports::*;

#[encrypted]
mod circuits {
    use arcis_imports::*;

    pub struct RebalancingInput {
        pub asset_balances: [u64; 3],
        pub asset_prices: [i64; 3],
        pub asset_weights: [u8; 3],
        pub asset_decimals: [u8; 3],
        pub threshold: u8,
    }

    #[derive(Copy, Clone)]
    pub struct SwapInstruction {
        pub from_asset: u8,
        pub to_asset: u8,
        pub amount: u64,
        pub min_output: u64,
    }

    pub struct RebalancingResult {
        pub swap_needed: bool,
        pub swap_count: u8,
        pub swaps: [SwapInstruction; 6],
        pub total_tvl_usd: i64,
        pub drifts: [i64; 3],
    }

    #[instruction]
    pub fn compute_rebalancing(
        input_ctxt: Enc<Shared, RebalancingInput>,
    ) -> Enc<Shared, RebalancingResult> {
        let input = input_ctxt.to_arcis();

        let mut total_usd: i64 = 0;
        let mut current_usds: [i64; 3] = [0; 3];

        for i in 0..3 {
            let usd_value = calculate_asset_usd(
                input.asset_balances[i],
                input.asset_prices[i],
                input.asset_decimals[i],
            );
            current_usds[i] = usd_value;
            total_usd += usd_value;
        }

        // Initialize result with default values
        let empty_swap = SwapInstruction {
            from_asset: 0,
            to_asset: 0,
            amount: 0,
            min_output: 0,
        };

        let mut result = RebalancingResult {
            swap_needed: false,
            swap_count: 0,
            swaps: [empty_swap; 6],
            total_tvl_usd: total_usd,
            drifts: [0; 3],
        };

        // Only compute if vault is not empty
        let is_empty = total_usd == 0;
        
        let mut drifts: [i64; 3] = [0; 3];
        let mut target_usds: [i64; 3] = [0; 3];
        let mut needs_rebalance = false;

        // Calculate drifts only if not empty
        for i in 0..3 {
            let target = if is_empty { 0 } else { (total_usd * input.asset_weights[i] as i64) / 100 };
            target_usds[i] = target;
            
            let current_pct = if is_empty { 0 } else { (current_usds[i] * 100) / total_usd };
            let drift_pct = current_pct - input.asset_weights[i] as i64;
            drifts[i] = drift_pct;

            let exceeds_threshold = drift_pct.abs() > input.threshold as i64;
            needs_rebalance = needs_rebalance || exceeds_threshold;
        }

        result.drifts = drifts;

        // Generate swaps only if not empty and rebalancing needed
        let should_generate_swaps = !is_empty && needs_rebalance;
        
        let mut swap_instructions: [SwapInstruction; 6] = [empty_swap; 6];
        let mut swap_count: u8 = 0;

        if should_generate_swaps {
            let mut excesses: [(u8, i64, bool); 3] = [(0, 0, false); 3];
            let mut deficits: [(u8, i64, bool); 3] = [(0, 0, false); 3];

            // Mark which assets have excess or deficit
            for i in 0..3 {
                let diff = current_usds[i] - target_usds[i];
                let has_excess = diff > 0;
                let has_deficit = diff < 0;
                
                if has_excess {
                    excesses[i] = (i as u8, diff, true);
                }
                if has_deficit {
                    deficits[i] = (i as u8, -diff, true);
                }
            }

            // Generate swaps from over-allocated to under-allocated assets
            // Fixed loop bounds (0..3 for each asset)
            for ex_idx in 0..3 {
                let (from_idx, mut remaining_excess, is_excess) = excesses[ex_idx];
                
                // Only process if this asset has excess
                if is_excess {
                    for def_idx in 0..3 {
                        let (to_idx, deficit_usd, is_deficit) = deficits[def_idx];
                        
                        // Check: has deficit, has remaining excess, space for swap, not same asset
                        let can_swap = is_deficit 
                            && (remaining_excess > 0) 
                            && (swap_count < 6)
                            && (from_idx != to_idx);
                        
                        if can_swap {
                            let swap_usd = if remaining_excess < deficit_usd {
                                remaining_excess
                            } else {
                                deficit_usd
                            };

                            let from_decimals = input.asset_decimals[from_idx as usize];
                            let to_decimals = input.asset_decimals[to_idx as usize];
                            let from_price = input.asset_prices[from_idx as usize];
                            let to_price = input.asset_prices[to_idx as usize];

                            let amount_in = calculate_token_amount(swap_usd, from_price, from_decimals);
                            let min_output = calculate_min_output(
                                amount_in,
                                from_price,
                                to_price,
                                from_decimals,
                                to_decimals,
                            );

                            swap_instructions[swap_count as usize] = SwapInstruction {
                                from_asset: from_idx,
                                to_asset: to_idx,
                                amount: amount_in,
                                min_output,
                            };

                            swap_count += 1;
                            remaining_excess -= swap_usd;
                        }
                    }
                }
            }
        }

        result.swap_needed = needs_rebalance && !is_empty;
        result.swap_count = swap_count;
        result.swaps = swap_instructions;

        input_ctxt.owner.from_arcis(result)
    }

    fn calculate_asset_usd(balance: u64, price: i64, decimals: u8) -> i64 {
        let is_zero = (balance == 0) || (price <= 0);
        
        let balance_scaled = balance as i128;
        let price_scaled = price as i128;
        let divisor = pow10(decimals as u32);
        let usd_value = (balance_scaled * price_scaled) / divisor;
        
        let clamped = if usd_value > i64::MAX as i128 {
            i64::MAX
        } else {
            usd_value as i64
        };
        
        if is_zero { 0 } else { clamped }
    }

    fn calculate_token_amount(usd_value: i64, price: i64, decimals: u8) -> u64 {
        let is_zero_price = price <= 0;
        
        let usd_scaled = usd_value as i128;
        let multiplier = pow10(decimals as u32);
        let price_scaled = price as i128;
        let amount = (usd_scaled * multiplier) / price_scaled;
        
        let clamped = if amount > u64::MAX as i128 {
            u64::MAX
        } else if amount < 0 {
            0
        } else {
            amount as u64
        };
        
        if is_zero_price { 0 } else { clamped }
    }

    fn calculate_min_output(
        amount_in: u64,
        from_price: i64,
        to_price: i64,
        from_decimals: u8,
        to_decimals: u8,
    ) -> u64 {
        let amount_scaled = amount_in as i128;
        let from_price_scaled = from_price as i128;
        let to_price_scaled = to_price as i128;
        let numerator = amount_scaled * from_price_scaled * pow10(to_decimals as u32);
        let denominator = to_price_scaled * pow10(from_decimals as u32);
        
        let is_zero_denom = denominator == 0;
        
        let expected_output = if is_zero_denom { 0 } else { numerator / denominator };
        let min_output = (expected_output * 99) / 100;
        
        let clamped = if min_output > u64::MAX as i128 {
            u64::MAX
        } else if min_output < 0 {
            0
        } else {
            min_output as u64
        };
        
        if is_zero_denom { 0 } else { clamped }
    }

    fn pow10(exp: u32) -> i128 {
        // Use if-else chain instead of match
        let result = if exp == 0 { 1 }
        else if exp == 1 { 10 }
        else if exp == 2 { 100 }
        else if exp == 3 { 1_000 }
        else if exp == 4 { 10_000 }
        else if exp == 5 { 100_000 }
        else if exp == 6 { 1_000_000 }
        else if exp == 7 { 10_000_000 }
        else if exp == 8 { 100_000_000 }
        else if exp == 9 { 1_000_000_000 }
        else if exp == 10 { 10_000_000_000 }
        else if exp == 11 { 100_000_000_000 }
        else if exp == 12 { 1_000_000_000_000 }
        else if exp == 13 { 10_000_000_000_000 }
        else if exp == 14 { 100_000_000_000_000 }
        else if exp == 15 { 1_000_000_000_000_000 }
        else if exp == 16 { 10_000_000_000_000_000 }
        else if exp == 17 { 100_000_000_000_000_000 }
        else if exp == 18 { 1_000_000_000_000_000_000 }
        else if exp == 19 { 10_000_000_000_000_000_000 }
        else if exp == 20 { 100_000_000_000_000_000_000 }
        else {
            // For exp > 20, we cap at 10^20 since we're dealing with token amounts
            // This is safe because max token amount is u64::MAX < 10^20
            100_000_000_000_000_000_000
        };
        
        result
    }
}
