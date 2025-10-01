use anchor_lang::prelude::*;
use anchor_lang::system_program::ID;

/// ========= Seeds =========
pub const STRATEGY_SEED: &[u8] = b"strategy";

/// Which protocol this implementation wraps.
#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum StrategyKind {
    Marinade = 0,
    Lido     = 1,
    Mock     = 255,
}

/// ========= Persistent state kept by each strategy instance =========
#[account]
pub struct StrategyState {
    /// Only this authority (your Vault program/PDA) may call the strategy.
    pub vault: Pubkey,
    /// Strategy kind (debug/sanity).
    pub kind: u8,
    /// External protocol program id (e.g., Marinade).
    pub protocol_program: Pubkey,
    /// Optional: position mint (e.g., mSOL) if the protocol issues one.
    pub position_mint: Pubkey,

    /// Total underlying allocated (lamports for SOL strategies).
    pub total_allocated: u64,

    /// Last reported value in underlying units.
    pub last_report_value: u64,
    /// Last time we harvested/reported.
    pub last_harvest_ts: i64,

    /// Safety switch.
    pub paused: bool,

    /// PDA bump.
    pub bump: u8,
}
impl StrategyState {
    pub const SIZE: usize =
        32 + 1 + 32 + 32 + // vault, kind, protocol_program, position_mint
        8 + 8 + 8 +        // total_allocated, last_report_value, last_harvest_ts
        1 + 1;             // paused, bump
}

/// ========= Instruction args =========
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub kind: u8,
    pub protocol_program: Pubkey,
    pub position_mint: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StakeArgs { pub amount: u64 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnstakeArgs { pub amount: u64 }

/// ========= Events you can assert in tests =========
#[event]
pub struct StrategyInitialized { pub vault: Pubkey, pub kind: u8 }

#[event]
pub struct Staked { pub amount: u64 }

#[event]
pub struct Unstaked { pub amount: u64 }

#[event]
pub struct Harvested { pub value_underlying: u64, pub ts: i64 }

#[event]
pub struct Reported { pub value_underlying: u64 }

/// ========= Common errors =========
#[error_code]
pub enum StrategyError {
    #[msg("Unauthorized: only the vault authority may call")]
    UnauthorizedVault,
    #[msg("Contract is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Invalid accounts or seeds")]
    InvalidAccounts,
    #[msg("Math error")]
    MathError,
}

/// ========= Optional trait (compile-time guide only) =========
/// NOTE: Traits do not form the on-chain ABI; they just help organize code inside each program.
pub trait Strategy {
    fn stake(&mut self, amount: u64) -> Result<()>;
    fn unstake(&mut self, amount: u64) -> Result<()>;
    fn harvest(&mut self) -> Result<u64>;
    fn report_value(&self) -> u64;
}

// crates/strategy-interface/src/lib.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strategy_state_size() {
        assert_eq!(StrategyState::SIZE, 32 + 1 + 32 + 32 + 8 + 8 + 8 + 1 + 1);
    }

    #[test]
    fn test_strategy_kind_values() {
        assert_eq!(StrategyKind::Marinade as u8, 0);
        assert_eq!(StrategyKind::Lido as u8, 1);
        assert_eq!(StrategyKind::Mock as u8, 255);
    }
}
