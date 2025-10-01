use anchor_lang::prelude::*;
use anchor_lang::system_program::ID;

// Re-export state module
pub mod state;
pub use state::*;
mod tests;
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
