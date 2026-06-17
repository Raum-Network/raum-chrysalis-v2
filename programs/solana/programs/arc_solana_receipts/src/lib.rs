use anchor_lang::prelude::*;

declare_id!("4q1nXm5Y5kAPuaCGonZz1S3cEPtzy67PfE1XPEtYptyd");

#[program]
pub mod arc_solana_receipts {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.config.admin = ctx.accounts.admin.key();
        Ok(())
    }

    pub fn record_receipt(ctx: Context<RecordReceipt>, intent_id: [u8; 32], source_chain: String, protocol: String, tx_signature: String) -> Result<()> {
        let receipt = &mut ctx.accounts.receipt;
        receipt.intent_id = intent_id;
        receipt.source_chain = source_chain;
        receipt.protocol = protocol;
        receipt.tx_signature = tx_signature;
        receipt.recorder = ctx.accounts.recorder.key();
        receipt.created_at = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + 32, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct RecordReceipt<'info> {
    #[account(init, payer = recorder, space = 8 + 32 + 4 + 32 + 4 + 64 + 4 + 128 + 32 + 8, seeds = [b"receipt", intent_id.as_ref()], bump)]
    pub receipt: Account<'info, Receipt>,
    #[account(mut)]
    pub recorder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
}

#[account]
pub struct Receipt {
    pub intent_id: [u8; 32],
    pub source_chain: String,
    pub protocol: String,
    pub tx_signature: String,
    pub recorder: Pubkey,
    pub created_at: i64,
}
