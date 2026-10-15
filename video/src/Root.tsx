import React from "react";
import { Composition } from "remotion";
import { FPS, WIDTH, HEIGHT } from "./brand";
import { ProductSpot, defaultProductSpotProps } from "./ProductSpot";
import {
  CreatorTip,
  defaultCreatorTipProps,
  creatorTipDuration,
  type CreatorTipProps,
} from "./CreatorTip";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="ProductSpot"
      component={ProductSpot}
      durationInFrames={540}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={defaultProductSpotProps}
    />
    <Composition
      id="CreatorTip"
      component={CreatorTip}
      durationInFrames={creatorTipDuration(defaultCreatorTipProps.tips)}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={defaultCreatorTipProps}
      // length follows the number of lessons in the props
      calculateMetadata={({ props }: { props: CreatorTipProps }) => ({
        durationInFrames: creatorTipDuration(props.tips),
      })}
    />
  </>
);
