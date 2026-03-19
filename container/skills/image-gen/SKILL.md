---
name: image-gen
description: Generate or edit images using Google's Nano Banana 2 (Gemini Imagen) model. Use whenever the user asks to create, draw, generate, or edit an image.
allowed-tools: Bash(generate-image*), mcp__nanoclaw__send_image
---

# Image Generation with Nano Banana 2

Generate or edit images using Google's Gemini Imagen API, then send them to the user.

## Workflow

1. Generate or edit the image with `generate-image`
2. Send it to the chat with `mcp__nanoclaw__send_image`

## Generate an image from a text prompt

```bash
generate-image --prompt "A golden retriever running through a field of sunflowers at sunset"
```

Prints the output path (e.g. `/workspace/group/generated-images/image-1234567890.png`).

## Edit an existing image

Use when the user sends a photo and asks to modify it.

```bash
generate-image --prompt "Make it look like a watercolor painting" --input /workspace/group/inbox/photo-1234567890.jpg
```

## Custom output path

```bash
generate-image --prompt "..." --output /workspace/group/generated-images/my-image.png
```

## Send the image to the user

After generating, send it with the `send_image` MCP tool:

```
mcp__nanoclaw__send_image(
  file_path="/workspace/group/generated-images/image-1234567890.png",
  caption="Here's your image!"
)
```

## Tips

- The image is always saved to `/workspace/group/generated-images/` by default
- For editing, input images must be under `/workspace/group/` (e.g. photos sent by the user land in `/workspace/group/inbox/`)
- Always send the image path from the `generate-image` output directly to `send_image`
- If generation fails, check that `GOOGLE_GEMINI_API_KEY` is configured
