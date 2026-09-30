"""WhatsApp Cloud API and Teams bot adapters.

Outbound calls happen only when credentials are set. Otherwise the port records
an error state and does not pretend the send succeeded.
"""
