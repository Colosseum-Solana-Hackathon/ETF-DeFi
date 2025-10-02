use anchor_lang::prelude::*;

declare_id!("99r9oxGjw29EvJBKEyQreaM8Hj45pP5La2URP1swANCJ");

#[program]
pub mod etf_defi {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
