// Pure movement math: from the player's look (yaw/pitch), the fly flag, and the held movement inputs
// (keys + joystick), the normalized world-space direction to move. No three.js — just numbers — so the
// engine's update() loop stays thin and this stays unit-tested.

export interface MoveInput {
  yaw: number;
  pitch: number;
  fly: boolean;
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  joystickActive: boolean;
  joystickX: number;
  joystickY: number;
}

export interface MoveVector {
  x: number;
  y: number;
  z: number;
}

export function moveVector(input: MoveInput): MoveVector {
  const flatX = Math.sin(input.yaw);
  const flatZ = Math.cos(input.yaw);
  const rightX = flatZ;
  const rightZ = -flatX;
  const forwardX = input.fly ? flatX * Math.cos(input.pitch) : flatX;
  const forwardY = input.fly ? Math.sin(input.pitch) : 0;
  const forwardZ = input.fly ? flatZ * Math.cos(input.pitch) : flatZ;

  let x = 0;
  let y = 0;
  let z = 0;
  if (input.forward) { x += forwardX; y += forwardY; z += forwardZ; }
  if (input.back) { x -= forwardX; y -= forwardY; z -= forwardZ; }
  if (input.right) { x -= rightX; z -= rightZ; }
  if (input.left) { x += rightX; z += rightZ; }
  if (input.joystickActive) {
    x += forwardX * -input.joystickY + rightX * -input.joystickX;
    y += forwardY * -input.joystickY;
    z += forwardZ * -input.joystickY + rightZ * -input.joystickX;
  }

  const length = Math.hypot(x, y, z);
  if (length === 0) return { x: 0, y: 0, z: 0 };
  return { x: x / length, y: y / length, z: z / length };
}
