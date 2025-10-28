use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

const COMP_DEF_OFFSET_COMPUTE_REBALANCING: u32 = comp_def_offset("compute_rebalancing");

declare_id!("6sQTw22nEhpV8byHif5M6zTJXSG1Gp8qtsTY4qfdq65K");

#[arcium_program]
pub mod rebalancing_mxe {
    use super::*;

    pub fn init_compute_rebalancing_comp_def(ctx: Context<InitComputeRebalancingCompDef>) -> Result<()> {
        // Store circuit ON-CHAIN for hackathon (simple and works)
        // use_onchain_source = true means circuit data is stored directly on-chain
        // This costs ~0.15 SOL per circuit but is perfect for demos
        init_comp_def(
            ctx.accounts,
            true,  // use_onchain_source = true (KEY CHANGE)
            0,     // version
            None,  // offchain_source (not used)
            None,  // extra_accounts (not used)
        )?;
        Ok(())
    }

    pub fn compute_rebalancing(
        ctx: Context<ComputeRebalancing>,
        computation_offset: u64,
        pub_key: [u8; 32],
        nonce: u128,
        encrypted_portfolio: [[u8; 32]; 13],
    ) -> Result<()> {
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;
        
        let mut args = vec![
            Argument::ArcisPubkey(pub_key),
            Argument::PlaintextU128(nonce),
        ];
        
        for encrypted_value in encrypted_portfolio.iter() {
            args.push(Argument::EncryptedU8(*encrypted_value));
        }

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            None,
            vec![ComputeRebalancingCallback::callback_ix(&[])],
        )?;

        Ok(())
    }

    #[arcium_callback(encrypted_ix = "compute_rebalancing")]
    pub fn compute_rebalancing_callback(
        ctx: Context<ComputeRebalancingCallback>,
        output: ComputationOutputs<ComputeRebalancingOutput>,
    ) -> Result<()> {
        let o = match output {
            ComputationOutputs::Success(ComputeRebalancingOutput { field_0 }) => field_0,
            _ => return Err(ErrorCode::AbortedComputation.into()),
        };

        let mut rebalanced_allocations = Vec::new();
        for ciphertext in o.ciphertexts.iter() {
            rebalanced_allocations.push(*ciphertext);
        }

        emit!(RebalancingEvent {
            allocations: rebalanced_allocations.try_into().unwrap_or([[0u8; 32]; 30]),
            nonce: o.nonce.to_le_bytes(),
        });
        Ok(())
    }
}

#[queue_computation_accounts("compute_rebalancing", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ComputeRebalancing<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, SignerAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(
        mut,
        address = derive_mempool_pda!()
    )]
    /// CHECK: mempool_account is validated by the Arcium program during computation queueing
    pub mempool_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_execpool_pda!()
    )]
    /// CHECK: executing_pool is validated by the Arcium program during computation execution
    pub executing_pool: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_comp_pda!(computation_offset)
    )]
    /// CHECK: computation_account is validated by the Arcium program for the specific computation
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPUTE_REBALANCING)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        mut,
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(
        mut,
        address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS,
    )]
    pub pool_account: Account<'info, FeePool>,
    #[account(
        address = ARCIUM_CLOCK_ACCOUNT_ADDRESS
    )]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("compute_rebalancing")]
#[derive(Accounts)]
pub struct ComputeRebalancingCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_COMPUTE_REBALANCING)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions_sysvar is validated by comparing against the instructions sysvar ID
    pub instructions_sysvar: AccountInfo<'info>,
}

#[init_computation_definition_accounts("compute_rebalancing", payer)]
#[derive(Accounts)]
pub struct InitComputeRebalancingCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account will be initialized by the Arcium program during this instruction
    pub comp_def_account: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct RebalancingEvent {
    pub allocations: [[u8; 32]; 30],
    pub nonce: [u8; 16],
}

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("Cluster not set")]
    ClusterNotSet,
}
