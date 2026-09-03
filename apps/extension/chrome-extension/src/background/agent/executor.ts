import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import type { NavigatorControlSignal } from './routing';
import { isFollowerReturnSignal, shouldResumeDrainLoop, shouldRunPlanner } from './routing';
import { runTurnWithGraph, shouldUseGraphExecutor } from './graph';

// Re-exported so tests and future callers have a single executor-side entry
// point for the ADR-002 router policy (implementation lives in ./routing).
export { shouldResumeDrainLoop, shouldRunPlanner } from './routing';
export type { NavigatorControlSignal } from './routing';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';
import { analytics } from '../services/analytics';
import type { RunSnapshot, RunTurnSource } from './run-state';
import { isRunning } from './run-state';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  private executeLoop: Promise<void> | null = null;

  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
    const initial = this.context.runSession.enqueue(task, 'user');
    initial.preapplied = true;
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string, source: RunTurnSource = 'user'): void {
    // Queue only. Work has not started — drainTurns applies it when the turn begins.
    this.context.runSession.enqueue(task, source);
    void this.context.emitEvent(Actors.SYSTEM, ExecutionState.RUN_UPDATE, task);
  }

  private applyFollowUp(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
    this.context.keepCurrentRewrittenScriptIds.clear();
  }

  getRunSnapshot(): RunSnapshot {
    return this.context.runSession.snapshot();
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      const collected = this.context.runSession.collectCompletion();
      if (collected.kind === 'previous_run') {
        logger.info(
          '✅ Planner confirms task completion for the in-flight turn; queued work has not started (previous run)',
        );
      } else {
        logger.info('✅ Planner confirms task completion');
      }
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task. Joins an in-flight loop if one is already draining
   * queued turns. Follow-ups submitted while running stay queued until the
   * current turn completes (completion of that turn is the previous run).
   */
  async execute(source: RunTurnSource = 'user'): Promise<void> {
    if (this.executeLoop) {
      return this.executeLoop;
    }
    this.executeLoop = this.drainTurns(source);
    try {
      await this.executeLoop;
    } finally {
      this.executeLoop = null;
    }
  }

  private async drainTurns(source: RunTurnSource): Promise<void> {
    while (!this.context.stopped) {
      let queued = this.context.runSession.beginQueued();
      if (!queued) {
        if (!isRunning(this.context.runSession.getClock()) && this.tasks.length > 0) {
          queued = {
            id: this.context.taskId,
            task: this.tasks[this.tasks.length - 1],
            enqueuedAt: Date.now(),
            source,
            preapplied: true,
          };
          this.context.runSession.begin(queued);
        } else if (isRunning(this.context.runSession.getClock())) {
          // Pause-between-turns resume: the turn stays marked running across
          // TASK_PAUSE with an empty queue, so continue the in-flight turn
          // instead of no-op break. Do not re-begin; the turn already holds
          // its runningTurnId.
          const snap = this.context.runSession.snapshot();
          queued = {
            id: snap.runningTurnId ?? this.context.taskId,
            task: this.tasks[this.tasks.length - 1],
            enqueuedAt: Date.now(),
            source: snap.runningTurnSource ?? source,
            preapplied: true,
          };
        } else {
          break;
        }
      } else if (!queued.preapplied) {
        this.applyFollowUp(queued.task);
      }

      await this.context.emitEvent(Actors.SYSTEM, ExecutionState.RUN_UPDATE, queued.task);
      await this.runPlannerNavigatorLoop();

      if (this.context.stopped) {
        this.context.runSession.cancel();
        await this.context.emitEvent(Actors.SYSTEM, ExecutionState.RUN_UPDATE, queued.task);
        break;
      }

      if (this.context.paused) {
        break;
      }

      if (this.context.runSession.snapshot().pendingQueue.length === 0) {
        break;
      }
    }
  }

  /**
   * Run one Planner/Navigator turn to a terminal task event.
   */
  private async runPlannerNavigatorLoop(): Promise<void> {
    // LangGraph rebase (flagged, default off): delegate turn-driving to the
    // StateGraph. Legacy path below is untouched when the flag is off.
    if (this.isGraphExecutorEnabled()) {
      await this.runPlannerNavigatorLoopGraph();
      return;
    }
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;
      let followerSignal: NavigatorControlSignal = 'CONTINUE';

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        // ADR-002 router: Follower control signal is primary, planningInterval
        // is the backstop cadence, maxSteps the safety valve. Event contract
        // (TASK_START/OK/FAIL/CANCEL/PAUSE, RUN_UPDATE) is unchanged.
        if (this.planner && shouldRunPlanner(context.nSteps, context.options.planningInterval, followerSignal)) {
          navigatorDone = false;
          followerSignal = 'CONTINUE';
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run
          if (this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }
        }

        // Execute navigator
        const navResult = await this.navigate();
        navigatorDone = navResult.done;
        followerSignal = navResult.control;

        // If navigator indicates completion, the next loop-top planner run validates it
        if (navigatorDone || isFollowerReturnSignal(followerSignal)) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;

      if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.runSession.complete({ output: finalMessage });
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.runSession.complete({ error: true, output: t('exec_errors_maxStepsReached') });
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.runSession.cancel();
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state; the turn stays running
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.runSession.cancel();
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.runSession.complete({ error: true, output: errorMessage });
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  private isGraphExecutorEnabled(): boolean {
    // Structural read: a future general-settings field can opt in without a
    // storage-schema change. Default stays USE_GRAPH_EXECUTOR=false.
    return shouldUseGraphExecutor(
      this.generalSettings as (GeneralSettingsConfig & { useGraphExecutor?: boolean }) | undefined,
    );
  }

  /**
   * Graph-driven twin of runPlannerNavigatorLoop (flag-only path).
   * Same event contract (TASK_START/OK/FAIL/CANCEL/PAUSE; RUN_UPDATE stays
   * with drainTurns) and same terminal mapping — only the turn-driving loop
   * is delegated to the StateGraph in ./graph, with runPlanner()/navigate()/
   * shouldStop() bound as the node callbacks so both paths run the same code.
   */
  private async runPlannerNavigatorLoopGraph(): Promise<void> {
    logger.info(`🚀 Executing task (graph): ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      const currentTask = this.tasks[this.tasks.length - 1];
      const runningTurnId = this.context.runSession.snapshot().runningTurnId;
      const result = await runTurnWithGraph({
        runId: runningTurnId ?? this.context.taskId,
        task: currentTask,
        planningInterval: this.context.options.planningInterval,
        maxSteps: allowedMaxSteps,
        initialNSteps: context.nSteps,
        onIteration: () => {
          context.stepInfo = {
            stepNumber: context.nSteps,
            maxSteps: context.options.maxSteps,
          };
        },
        runLeader: async () => {
          const planOutput = await this.runPlanner();
          if (this.checkTaskCompletion(planOutput)) {
            return { planDone: true, finalAnswer: this.context.finalAnswer };
          }
          return { planDone: false, finalAnswer: null };
        },
        runFollower: async () => {
          const navResult = await this.navigate();
          // If navigator indicates completion, the next loop-top planner run validates it
          if (navResult.done || isFollowerReturnSignal(navResult.control)) {
            logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
          }
          return { done: navResult.done, control: navResult.control, nSteps: context.nSteps };
        },
        shouldStop: () => this.shouldStop(),
        isStopped: () => this.context.stopped,
      });

      // Determine task completion status
      const isCompleted = result.planDone;

      if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.runSession.complete({ output: finalMessage });
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (result.stepsConsumed >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.runSession.complete({ error: true, output: t('exec_errors_maxStepsReached') });
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.runSession.cancel();
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state; the turn stays running
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.runSession.cancel();
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.runSession.complete({ error: true, output: errorMessage });
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private async navigate(): Promise<{ done: boolean; control: NavigatorControlSignal }> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return { done: false, control: 'CONTINUE' };
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return { done: false, control: 'CONTINUE' };
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result) {
        // Prefer the typed Follower signal; fall back to `done` for older results.
        const control: NavigatorControlSignal =
          navOutput.result.control ?? (navOutput.result.done ? 'SUBGOAL_COMPLETE' : 'CONTINUE');
        return { done: navOutput.result.done, control };
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      // A failed Navigator step blocks forward progress — return control to
      // the Leader rather than silently continuing until the interval fires.
      return { done: false, control: 'BLOCKED' };
    }
    return { done: false, control: 'CONTINUE' };
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.runSession.cancel();
    this.context.stop();
    await this.context.emitEvent(Actors.SYSTEM, ExecutionState.RUN_UPDATE, this.context.taskId);
  }

  async resume(): Promise<void> {
    if (!this.context.paused) {
      return;
    }
    this.context.resume();
    await this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_RESUME, t('exec_task_resume'));
    const snapshot = this.context.runSession.snapshot();
    if (shouldResumeDrainLoop(snapshot, this.executeLoop !== null)) {
      void this.execute();
    }
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    if (this.executeLoop) {
      await this.executeLoop;
    }

    let results: ActionResult[] = [];
    this.executeLoop = (async () => {
      results = await this.runReplayHistory(sessionId, maxRetries, skipFailures, delayBetweenActions);
      if (!this.context.stopped && this.context.runSession.snapshot().pendingQueue.length > 0) {
        await this.drainTurns('user');
      }
    })();

    try {
      await this.executeLoop;
    } finally {
      this.executeLoop = null;
    }

    return results;
  }

  private async runReplayHistory(
    sessionId: string,
    maxRetries: number,
    skipFailures: boolean,
    delayBetweenActions: number,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      // The constructor queues a synthetic preapplied task for ordinary execution.
      // Keep real follow-ups that arrived while replay history was loading.
      this.context.runSession.discardPreappliedQueue();
      this.context.runSession.begin({
        id: sessionId,
        task: this.tasks[0],
        enqueuedAt: Date.now(),
        source: 'replay',
      });
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.runSession.cancel();
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.runSession.complete({ output: t('exec_replay_ok') });
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.runSession.complete({ error: true, output: errorMessage });
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
