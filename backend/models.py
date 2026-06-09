"""Pydantic models for SPILIVERE API."""
from __future__ import annotations
from datetime import datetime
from typing import Optional, List, Dict
from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
    username: str = Field(min_length=4, max_length=30, pattern=r"^[a-zA-Z0-9_]+$")
    email: EmailStr
    country: str  # country code (e.g. "TG")
    phone: str = Field(min_length=6, max_length=20)
    password: str = Field(min_length=8, max_length=128)
    password_confirm: str
    sponsor_username: str  # required (referral link mandatory)
    accept_terms: bool


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)
    new_password_confirm: str


class ConfirmPasswordIn(BaseModel):
    password: str


class ActivationRequestIn(BaseModel):
    level: int
    payment_method: str  # mobile_money | card | crypto
    operator: Optional[str] = None  # operator name for mobile money
    payment_phone: Optional[str] = None  # phone used to pay
    transaction_ref: Optional[str] = None  # user's MoMo transaction reference


class WalletIn(BaseModel):
    country: str
    full_name: str
    method: Optional[str] = "mobile"  # "mobile" | "crypto"
    # Mobile Money fields
    operator: Optional[str] = ""
    phone: Optional[str] = ""
    # Crypto fields
    network: Optional[str] = "USDT BEP20"
    wallet_address: Optional[str] = ""


class WithdrawalIn(BaseModel):
    amount: int


class AnnouncementIn(BaseModel):
    title: str
    message: str
    priority: str = "normale"  # normale | importante | urgente
    image_url: Optional[str] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    active: bool = True


class ChannelIn(BaseModel):
    name: str
    url: str
    platform: str  # telegram | whatsapp | facebook | tiktok | instagram | youtube | x
    description: Optional[str] = None
    active: bool = True


class UpdateProfileIn(BaseModel):
    phone: Optional[str] = None
    email: Optional[EmailStr] = None


class AdminUserActionIn(BaseModel):
    action: str  # ban | unban | block | unblock | delete | disable_withdrawals | enable_withdrawals | reset_password | change_sponsor | credit_wallet | debit_wallet | make_admin | remove_admin | make_promoter | remove_promoter | activate_level | deactivate_level | move_matrix | add_note
    new_password: Optional[str] = None
    new_sponsor_username: Optional[str] = None
    amount: Optional[int] = None
    bucket: Optional[str] = None  # profit | upgrade (for credit/debit)
    level: Optional[int] = None
    note: Optional[str] = None
    new_parent_username: Optional[str] = None
    new_leg: Optional[str] = None  # left | right
