// mbedtls AES subset on top of OpenSSL's low-level AES (enough for crypto.h).
#pragma once
#include <openssl/aes.h>
#include <string.h>
#define MBEDTLS_AES_ENCRYPT 1
#define MBEDTLS_AES_DECRYPT 0
typedef struct { AES_KEY k; } mbedtls_aes_context;
inline void mbedtls_aes_init(mbedtls_aes_context*) {}
inline void mbedtls_aes_free(mbedtls_aes_context*) {}
inline int mbedtls_aes_setkey_enc(mbedtls_aes_context* c, const unsigned char* key, unsigned bits) { return AES_set_encrypt_key(key, bits, &c->k); }
inline int mbedtls_aes_setkey_dec(mbedtls_aes_context* c, const unsigned char* key, unsigned bits) { return AES_set_decrypt_key(key, bits, &c->k); }
inline int mbedtls_aes_crypt_ecb(mbedtls_aes_context* c, int mode, const unsigned char in[16], unsigned char out[16]) { AES_ecb_encrypt(in, out, &c->k, mode ? AES_ENCRYPT : AES_DECRYPT); return 0; }
inline int mbedtls_aes_crypt_cbc(mbedtls_aes_context* c, int mode, size_t len, unsigned char iv[16], const unsigned char* in, unsigned char* out) { AES_cbc_encrypt(in, out, len, &c->k, iv, mode ? AES_ENCRYPT : AES_DECRYPT); return 0; }
