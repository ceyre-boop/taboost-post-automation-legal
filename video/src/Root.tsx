import React from "react";
import { Composition } from "remotion";
import { FPS, WIDTH, HEIGHT } from "./brand";
import { ProductSpot, defaultProductSpotProps } from "./ProductSpot";
import { HypeBotDemo, defaultHypeBotDemoProps, hypeBotDemoDuration } from "./HypeBotDemo";
import {
  CreatorTip,
  defaultCreatorTipProps,
  creatorTipDuration,
  type CreatorTipProps,
} from "./CreatorTip";
import {
  LiveLesson,
  defaultLiveLessonProps,
  liveLessonDuration,
  type LiveLessonProps,
} from "./LiveLesson";
import {
  BattleDemo,
  defaultBattleDemoProps,
  battleDemoDuration,
  type BattleDemoProps,
} from "./BattleDemo";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="HypeBotDemo"
      component={HypeBotDemo}
      durationInFrames={hypeBotDemoDuration}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={defaultHypeBotDemoProps}
    />
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
    <Composition
      id="LiveLesson"
      component={LiveLesson}
      durationInFrames={liveLessonDuration(defaultLiveLessonProps.points)}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={defaultLiveLessonProps}
      calculateMetadata={({ props }: { props: LiveLessonProps }) => ({
        durationInFrames: liveLessonDuration(props.points),
      })}
    />
    <Composition
      id="BattleDemo"
      component={BattleDemo}
      durationInFrames={battleDemoDuration(defaultBattleDemoProps.steps)}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={defaultBattleDemoProps}
      calculateMetadata={({ props }: { props: BattleDemoProps }) => ({
        durationInFrames: battleDemoDuration(props.steps),
      })}
    />
  </>
);
