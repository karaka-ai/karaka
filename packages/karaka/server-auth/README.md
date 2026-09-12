# Karaka server authentication

The existing shared-bearer provider authenticates application servers and resolves separate outbound MCP credentials. Both directions resolve credential references on each operation, allowing rotation without placing secrets in Session data. Application identity types belong to `@karaka-ai/identity`; DSH Session remains unchanged.

## Model Experience

Authentication contributes no model tokens or prompt changes. It gates application requests and supplies authenticated outbound tool headers.

## Known Limitations and Deferred Work

Validation is restricted to the selected backend end-to-end flow. Other credential providers and rotation failure paths have not been separately exercised in this implementation.
