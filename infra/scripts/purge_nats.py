import asyncio
import nats
import os

async def main():
    nc = await nats.connect(os.getenv("NATS_URL", "nats://nats:4222"))
    js = nc.jetstream()
    stream = "EVIDENCELENS"
    print(f"Purging stream: {stream}")
    await js.purge_stream(stream)
    print("Purge complete.")
    await nc.close()

if __name__ == "__main__":
    asyncio.run(main())
