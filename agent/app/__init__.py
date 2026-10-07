"""CRM Bee conversation agent: LangChain chains that turn untrusted chat/card/voice/email content into
strictly validated structured data. The agent has NO authority: it never sees tenants, users, record ids or
credentials, cannot call tools, and its output is re-validated by the TypeScript service before anything runs."""
