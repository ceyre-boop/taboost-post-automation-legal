import React from "react";
import { Composition } from "remotion";
import { FPS, WIDTH, HEIGHT } from "./brand";
import { ProductSpot, defaultProductSpotProps } from "./ProductSpot";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="ProductSpot"
    component={ProductSpot}
    durationInFrames={540}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={defaultProductSpotProps}
  />
);
