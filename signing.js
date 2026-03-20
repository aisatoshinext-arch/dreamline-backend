// Dreamline Cryptographic Signing Module
// EIP-712 structured data signing for multi-chain enforcement
// Compatible with all EVM chains: Ethereum, BNB Chain, Base, Polygon, etc.

const { ethers } = require('ethers');
if (process.env.NODE_ENV !== 'production') require('dotenv').config();

// Generate or load Dreamline's signing wallet
// In production this private key is stored in a HSM (Hardware Security Module)
let dreamlineWallet;

function getWallet() {
  if (dreamlineWallet) return dreamlineWallet;
  
  if (process.env.DREAMLINE_PRIVATE_KEY) {
    dreamlineWallet = new ethers.Wallet(process.env.DREAMLINE_PRIVATE_KEY);
  } else {
    // Generate a deterministic wallet from a seed for demo purposes
    const seed = 'dreamline-demo-signing-key-v1-do-not-use-in-production';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
    dreamlineWallet = new ethers.Wallet(hash);
  }
  
  console.log('[Signing] Dreamline signer address:', dreamlineWallet.address);
  return dreamlineWallet;
}

// EIP-712 domain for Dreamline
function getDomain(chainId) {
  return {
    name: 'Dreamline',
    version: '1',
    chainId: chainId || 1,
    verifyingContract: '0x0000000000000000000000000000000000000000'
  };
}

// EIP-712 types for payment approval
const PAYMENT_APPROVAL_TYPES = {
  PaymentApproval: [
    { name: 'agentId', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'amountUsd', type: 'uint256' },
    { name: 'paymentRail', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' }
  ]
};

// Sign a payment approval
async function signPaymentApproval({
  agent_id,
  destination,
  amount_usd,
  payment_rail,
  chain_id
}) {
  const wallet = getWallet();
  const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes
  const nonce = Math.floor(Date.now() / 1000);
  const amountInCents = Math.round(parseFloat(amount_usd) * 100);

  const domain = getDomain(chain_id || 1);
  const message = {
    agentId: agent_id,
    destination,
    amountUsd: amountInCents,
    paymentRail: payment_rail || 'x402',
    nonce,
    expiresAt
  };

  const signature = await wallet.signTypedData(domain, PAYMENT_APPROVAL_TYPES, message);

  return {
    signature,
    signer: wallet.address,
    message,
    domain,
    expires_at: new Date(expiresAt * 1000).toISOString(),
    chain_id: chain_id || 1
  };
}

// Verify a signature (for testing)
function verifySignature({ signature, message, domain }) {
  try {
    const recoveredAddress = ethers.verifyTypedData(
      domain,
      PAYMENT_APPROVAL_TYPES,
      message,
      signature
    );
    const wallet = getWallet();
    return {
      valid: recoveredAddress.toLowerCase() === wallet.address.toLowerCase(),
      signer: recoveredAddress,
      expected: wallet.address
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// Get Dreamline's public signer address
function getSignerAddress() {
  return getWallet().address;
}

// Generate Solidity verification code for a specific signer address
function getSolidityContract(signerAddress) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title DreamlineGated
 * @notice Contract that requires Dreamline's signature before executing payments
 * @dev Deploy this on any EVM chain — Ethereum, BNB Chain, Base, Polygon, etc.
 */
contract DreamlineGated is EIP712 {
    using ECDSA for bytes32;

    // Dreamline's public signer address — only Dreamline has the private key
    address public constant DREAMLINE_SIGNER = ${signerAddress};

    bytes32 private constant PAYMENT_APPROVAL_TYPEHASH = keccak256(
        "PaymentApproval(string agentId,string destination,uint256 amountUsd,string paymentRail,uint256 nonce,uint256 expiresAt)"
    );

    mapping(uint256 => bool) public usedNonces;

    constructor() EIP712("Dreamline", "1") {}

    /**
     * @notice Execute a payment — requires valid Dreamline signature
     * @dev Without Dreamline's signature this function reverts automatically
     */
    function executePayment(
        string memory agentId,
        string memory destination,
        uint256 amountUsd,
        string memory paymentRail,
        uint256 nonce,
        uint256 expiresAt,
        bytes memory dreamlineSignature
    ) external {
        // Check signature has not expired
        require(block.timestamp <= expiresAt, "Dreamline approval expired");

        // Check nonce has not been used (prevents replay attacks)
        require(!usedNonces[nonce], "Nonce already used");
        usedNonces[nonce] = true;

        // Reconstruct the signed message hash
        bytes32 structHash = keccak256(abi.encode(
            PAYMENT_APPROVAL_TYPEHASH,
            keccak256(bytes(agentId)),
            keccak256(bytes(destination)),
            amountUsd,
            keccak256(bytes(paymentRail)),
            nonce,
            expiresAt
        ));

        bytes32 hash = _hashTypedDataV4(structHash);

        // Verify Dreamline's signature
        address signer = hash.recover(dreamlineSignature);
        require(signer == DREAMLINE_SIGNER, "Invalid Dreamline signature");

        // ✅ Signature verified — execute payment here
        // Example: IERC20(token).transfer(destination, amount);
        // Without valid signature this line is never reached
    }
}`;
}

module.exports = {
  signPaymentApproval,
  verifySignature,
  getSignerAddress,
  getSolidityContract,
  getWallet
};