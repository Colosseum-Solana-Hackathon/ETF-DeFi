pub fn add(left: u64, right: u64) -> u64 {
    left + right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_works() {
        let result = add(2, 2);
        assert_eq!(result, 4);
    }
}

use anchor_lang::prelude::*;

/// Common interface that all yield strategies (Marinade, Lido, etc.) must implement.
pub trait Strategy {
    /// Deposit SOL or tokens into the strategy.
    fn stake(&mut self, amount: u64, ctx: Context<AccountInfo>) -> Result<()>;

    /// Withdraw funds back to the vault.
    fn unstake(&mut self, amount: u64, ctx: Context<AccountInfo>) -> Result<()>;

    ///develop a withdraw function as well to call once the withdraw cooldown ends
    
    
    /// Harvest any accumulated yield.
    fn harvest(&mut self, ctx: Context<AccountInfo>) -> Result<u64>;

    /// Get how much the vault currently has allocated.
    fn balance(&self) -> u64;

}
