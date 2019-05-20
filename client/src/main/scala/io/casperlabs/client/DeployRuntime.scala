package io.casperlabs.client
import java.io.File
import java.nio.file.Files

import cats.Apply
import cats.effect.{Sync, Timer}
import cats.syntax.all._
import com.google.protobuf.ByteString
import guru.nidi.graphviz.engine._
import io.casperlabs.casper.protocol._
import io.casperlabs.casper.consensus
import io.casperlabs.client.configuration.Streaming
import io.casperlabs.crypto.hash.Blake2b256
import io.casperlabs.crypto.signatures.Ed25519
import io.casperlabs.crypto.codec.Base16
import java.nio.charset.StandardCharsets
import scala.concurrent.duration._
import scala.language.higherKinds
import scala.util.Try

object DeployRuntime {

  def propose[F[_]: Sync: DeployService](): F[Unit] =
    gracefulExit(
      for {
        response <- DeployService[F].propose()
      } yield response.map(r => s"Response: $r")
    )

  def showBlock[F[_]: Sync: DeployService](hash: String): F[Unit] =
    gracefulExit(DeployService[F].showBlock(BlockQuery(hash)))

  def showBlocks[F[_]: Sync: DeployService](depth: Int): F[Unit] =
    gracefulExit(DeployService[F].showBlocks(BlocksQuery(depth)))

  def visualizeDag[F[_]: Sync: DeployService: Timer](
      depth: Int,
      showJustificationLines: Boolean,
      maybeOut: Option[String],
      maybeStreaming: Option[Streaming]
  ): F[Unit] =
    gracefulExit({
      def askDag =
        DeployService[F]
          .visualizeDag(VisualizeDagQuery(depth, showJustificationLines))
          .rethrow

      val useJdkRenderer = Sync[F].delay(Graphviz.useEngine(new GraphvizJdkEngine))

      def writeToFile(out: String, format: Format, dag: String) =
        Sync[F].delay(
          Graphviz
            .fromString(dag)
            .render(format)
            .toFile(new File(s"$out"))
        ) >> Sync[F].delay(println(s"Wrote $out"))

      val sleep = Timer[F].sleep(5.seconds)

      def subscribe(
          out: String,
          streaming: Streaming,
          format: Format,
          index: Int = 0,
          prevDag: Option[String] = None
      ): F[Unit] =
        askDag >>= {
          dag =>
            if (prevDag.contains(dag)) {
              sleep >>
                subscribe(out, streaming, format, index, prevDag)
            } else {
              val filename = streaming match {
                case Streaming.Single => out
                case Streaming.Multiple =>
                  val extension = "." + out.split('.').last
                  out.stripSuffix(extension) + s"_$index" + extension
              }
              writeToFile(filename, format, dag) >>
                sleep >>
                subscribe(out, streaming, format, index + 1, dag.some)
            }
        }

      def parseFormat(out: String) = Sync[F].delay(Format.valueOf(out.split('.').last.toUpperCase))

      val eff = (maybeOut, maybeStreaming) match {
        case (None, None) =>
          askDag
        case (Some(out), None) =>
          useJdkRenderer >>
            askDag >>= { dag =>
            parseFormat(out) >>=
              (format => writeToFile(out, format, dag).map(_ => "Success"))
          }
        case (Some(out), Some(streaming)) =>
          useJdkRenderer >>
            parseFormat(out) >>=
            (subscribe(out, streaming, _).map(_ => "Success"))
        case (None, Some(_)) =>
          Sync[F].raiseError[String](new Throwable("--out must be specified if --stream"))
      }
      eff.attempt
    })

  def deployFileProgram[F[_]: Sync: DeployService](
      from: String,
      nonce: Long,
      sessionCode: File,
      paymentCode: File,
      maybePublicKey: Option[File],
      maybePrivateKey: Option[File]
  ): F[Unit] = {
    def readFile(file: File) =
      Sync[F].fromTry(
        Try(ByteString.copyFrom(Files.readAllBytes(file.toPath)))
      )

    // TODO: Update to use Base64 and PEM.
    def readBase16(file: File) =
      for {
        raw   <- readFile(file)
        str   = new String(raw.toByteArray, StandardCharsets.UTF_8)
        bytes = Base16.decode(str)
      } yield bytes

    val deploy = for {
      session <- readFile(sessionCode)
      payment <- readFile(paymentCode)
      privateKey <- maybePrivateKey match {
                     case Some(file) => readBase16(file)
                     case None       => Array.empty[Byte].pure[F]
                   }
      publicKey <- maybePublicKey match {
                    case Some(file) => readBase16(file)
                    case None if privateKey.nonEmpty =>
                      Ed25519.toPublic(privateKey).pure[F]
                    case None => Array.empty[Byte].pure[F]
                  }
    } yield {
      val deploy = consensus
        .Deploy()
        .withHeader(
          consensus.Deploy
            .Header()
            .withTimestamp(System.currentTimeMillis)
            // NOTE: For now using this field is also used to carry over the account address,
            // which has been removed from Deploy. Should eventually disappear from the CLI entirely.
            .withAccountPublicKey(
              Option(ByteString.copyFrom(publicKey)).filterNot(_.isEmpty) getOrElse ByteString
                .copyFromUtf8(from)
            )
            .withNonce(nonce)
        )
        .withBody(
          consensus.Deploy
            .Body()
            .withSession(consensus.Deploy.Code().withCode(session))
            .withPayment(consensus.Deploy.Code().withCode(payment))
        )
        .withHashes

      Option(privateKey).filterNot(_.isEmpty).map(deploy.sign(_)) getOrElse deploy
    }

    gracefulExit(
      deploy
        .flatMap(DeployService[F].deploy)
        .handleError(
          ex => Left(new RuntimeException(s"Couldn't make deploy, reason: ${ex.getMessage}", ex))
        )
    )
  }

  private[client] def gracefulExit[F[_]: Sync](program: F[Either[Throwable, String]]): F[Unit] =
    for {
      result <- Sync[F].attempt(program)
      _ <- result.joinRight match {
            case Left(ex) =>
              Sync[F].delay {
                System.err.println(processError(ex).getMessage)
                System.exit(1)
              }
            case Right(msg) =>
              Sync[F].delay {
                println(msg)
                System.exit(0)
              }
          }
    } yield ()

  private def processError(t: Throwable): Throwable =
    Option(t.getCause).getOrElse(t)

  private def hash[T <: scalapb.GeneratedMessage](data: T): ByteString =
    ByteString.copyFrom(Blake2b256.hash(data.toByteArray))

  implicit class DeployOps(d: consensus.Deploy) {
    def withHashes = {
      val h = d.getHeader.withBodyHash(hash(d.getBody))
      d.withHeader(h).withDeployHash(hash(h))
    }

    def sign(privateKey: Array[Byte]) = {
      val sig = Ed25519.sign(d.deployHash.toByteArray, privateKey)
      d.withSignature(
        consensus
          .Signature()
          .withSigAlgorithm("ed25519")
          .withSig(ByteString.copyFrom(sig))
      )
    }
  }

}
