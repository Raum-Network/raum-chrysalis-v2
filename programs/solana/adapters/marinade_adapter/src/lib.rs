use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_lang::solana_program::{
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

declare_id!("BiFFicCD6nAnLBBbuf1kFE9h6cbd895e1kTzYRJHJWmm");

#[program]
pub mod marinade_adapter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, marinade_program: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.marinade_program = marinade_program;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn force_init(ctx: Context<ForceInit>, marinade_program: Pubkey) -> Result<()> {
        let dst = &ctx.accounts.config;
        let data = &mut dst.data.borrow_mut();
        let disc = crate::Config::discriminator();
        data[..8].copy_from_slice(&disc);
        data[8..40].copy_from_slice(ctx.accounts.admin.key().as_ref());
        data[40..72].copy_from_slice(marinade_program.as_ref());
        data[72] = 0;
        let (_, bump) = Pubkey::find_program_address(&[b"marinade-config"], &crate::ID);
        data[73] = bump;
        Ok(())
    }

    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    pub fn deposit_with_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteSwapDeposit<'info>>,
        swap_amount: u64,
        min_out_amount: u64,
        deposit_amount: u64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, AdapterError::Paused);
        require!(
            ctx.accounts.authority.key() == config.admin,
            AdapterError::Unauthorized
        );

        let remaining = ctx.remaining_accounts;

        let swap_accts = vec![
            AccountMeta::new(remaining[0].key(), true),
            AccountMeta::new_readonly(remaining[1].key(), false),
            AccountMeta::new_readonly(remaining[2].key(), false),
            AccountMeta::new(remaining[3].key(), false),
            AccountMeta::new(remaining[4].key(), false),
            AccountMeta::new(remaining[5].key(), false),
            AccountMeta::new(remaining[6].key(), false),
            AccountMeta::new(remaining[7].key(), false),
            AccountMeta::new_readonly(remaining[8].key(), false),
            AccountMeta::new_readonly(remaining[9].key(), false),
            AccountMeta::new_readonly(remaining[10].key(), false),
            AccountMeta::new_readonly(remaining[11].key(), false),
            AccountMeta::new(remaining[12].key(), false),
        ];
        let sd = hashv(&[b"global:swap_base_input"]).to_bytes();
        let mut sd_vec = sd[..8].to_vec();
        sd_vec.extend_from_slice(&swap_amount.to_le_bytes());
        sd_vec.extend_from_slice(&min_out_amount.to_le_bytes());
        invoke(
            &Instruction {
                program_id: *ctx.accounts.raydium_cpmm_program.key,
                accounts: swap_accts,
                data: sd_vec,
            },
            &remaining[..13],
        )?;

        invoke(
            &Instruction {
                program_id: ctx.accounts.token_program.key(),
                accounts: vec![
                    AccountMeta::new(remaining[5].key(), false),
                    AccountMeta::new(ctx.accounts.authority.key(), false),
                    AccountMeta::new_readonly(ctx.accounts.authority.key(), true),
                ],
                data: vec![9],
            },
            &[
                remaining[5].clone(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;

        let dd = hashv(&[b"global:deposit"]).to_bytes();
        let mut dd_vec = dd[..8].to_vec();
        dd_vec.extend_from_slice(&deposit_amount.to_le_bytes());
        invoke(
            &Instruction {
                program_id: *ctx.accounts.marinade_program.key,
                accounts: vec![
                    AccountMeta::new(remaining[13].key(), false),
                    AccountMeta::new(remaining[14].key(), false),
                    AccountMeta::new(remaining[15].key(), false),
                    AccountMeta::new(remaining[16].key(), false),
                    AccountMeta::new_readonly(remaining[17].key(), false),
                    AccountMeta::new(remaining[18].key(), false),
                    AccountMeta::new(ctx.accounts.authority.key(), true),
                    AccountMeta::new(remaining[20].key(), false),
                    AccountMeta::new_readonly(remaining[21].key(), false),
                    AccountMeta::new_readonly(remaining[22].key(), false),
                    AccountMeta::new_readonly(remaining[23].key(), false),
                ],
                data: dd_vec,
            },
            &remaining[13..],
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = Config::SIZE, seeds = [b"marinade-config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ForceInit<'info> {
    /// CHECK: overwritten manually with correct Config layout
    #[account(mut)]
    pub config: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"marinade-config"], bump = config.bump, has_one = admin @ AdapterError::Unauthorized)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteSwapDeposit<'info> {
    #[account(mut, seeds = [b"marinade-config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Marinade program
    pub marinade_program: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM program
    pub raydium_cpmm_program: UncheckedAccount<'info>,
    /// CHECK: Token program
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub marinade_program: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1;
}

#[error_code]
pub enum AdapterError {
    #[msg("paused")]
    Paused,
    #[msg("unauthorized")]
    Unauthorized,
}
