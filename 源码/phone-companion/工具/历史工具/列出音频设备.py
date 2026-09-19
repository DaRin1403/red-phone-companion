import sounddevice as sd
hosts = sd.query_hostapis()
for i,h in enumerate(hosts):
    print(f"[{i}] {h['name']}")
print("-"*50)
for i,d in enumerate(sd.query_devices()):
    if d['max_input_channels']>0 or d['max_output_channels']>0:
        print(f"{i:>3} | in={d['max_input_channels']} out={d['max_output_channels']} | {d['name']}")
